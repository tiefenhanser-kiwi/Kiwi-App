// [prepcook] B1 — THE BREAK HARNESS. Restores every file it touches.
//
// Each break applies ONE exact-string edit to a committed file, runs the test
// file that is supposed to catch it, and restores the original bytes. A break
// that comes back GREEN is reported as a FAILED BREAK: the test does not pin the
// fix, which is worth more than a passing suite.
//
// The anchor is matched EXACTLY and the break ABORTS if it is missing, so a
// refactor that moves a line can never silently skip a break and be reported as
// green. sha256 before and after proves the restore.
//
//   node --import tsx scripts/prep-cook-census/breaks.ts
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "../..");          // artifacts/api-server
const KIWI = resolve(API, "../kiwi");        // artifacts/kiwi

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

interface Break {
  n: number;
  ruling: string;
  file: string;
  cwd: string;
  /**
   * One or more exact-string edits, applied together.
   *
   * 🔴 SOME DEFECTS ARE HELD OFF BY TWO GUARDS AND NEED BOTH REMOVED. Break 9
   * is the case: for a served-cold dish, "staying warm" is prevented BOTH by
   * STATE_FROM_PHASE having no `hold` entry AND by the cold-dish veto, and
   * either alone is sufficient — so a single-edit break came back green and
   * reported a test that pinned nothing. Two guards is the better code; the
   * break just has to say so.
   */
  edits: { from: string; to: string }[];
  test: string;
  /** How the test run is invoked in that package. */
  runner: "api" | "kiwi";
  expect: string;
}

const BREAKS: Break[] = [
  {
    n: 1,
    ruling: "1 — the latest bound",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    edits: [{ from: "export const LAG_AFTER_HEAT_REST = 2;\nexport const LAG_AFTER_HEAT_OTHER = 5;", to: "export const LAG_AFTER_HEAT_REST = Infinity;\nexport const LAG_AFTER_HEAT_OTHER = Infinity;" }],
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "the Carne Asada rest gap returns to 20 min",
  },
  {
    n: 2,
    ruling: "2 — the cue's state",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    edits: [
      {
        from: '{ re: /\\b(refrigerat\\w*|chill\\w*|in the fridge|ice bath)\\b/i, state: "chilling" }',
        to: '{ re: /\\bZZZ_NEVER_MATCHES\\b/i, state: "chilling" }',
      },
    ],
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "the guacamole's refrigerate step stops being read as chilling",
  },
  {
    n: 3,
    ruling: "2 — the tie",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    edits: [{ from: "    (o, oIdx) =>\n      oIdx < seqIdx &&\n      o.dishId !== w.dishId &&", to: "    (o, _oIdx) =>\n      o.dishId !== w.dishId &&" }],
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "a cue points forward at a step the cook has not begun",
  },
  {
    n: 4,
    ruling: "3 — cold dishes forward",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    edits: [{ from: "  if (COLD_DISH_EXCEPTION.test(title)) return false;\n  return COLD_DISH_TITLE.test(title);", to: "  if (COLD_DISH_EXCEPTION.test(title)) return false;\n  return false;" }],
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "pico is finish-aligned again and the marinade window stays empty",
  },
  {
    n: 5,
    ruling: "5 — the third clock",
    file: join(KIWI, "lib/cooking/stepTiming.ts"),
    cwd: KIWI,
    edits: [{ from: "  const step = steps[Math.max(0, fromIndex)];\n  const off = step?.startOffsetMinutes;\n  if (off == null) return null;\n  return Math.max(0, -off);", to: "  void steps;\n  void fromIndex;\n  return null;" }],
    test: "lib/cooking/__tests__/cookClockBug337.test.ts",
    runner: "kiwi",
    expect: "the footer falls back to the flat sum and reads 116 for the Carne Asada",
  },
  {
    n: 6,
    ruling: "7 — glyphs and counts",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "  if (best === null) return String(Number(q.toFixed(2)));\n  return mixedNumber(whole, best.glyph);", to: "  void best;\n  return String(Number(q.toFixed(2)));" }],
    test: "src/lib/__tests__/prepWeekAssembly.test.ts",
    runner: "api",
    expect: "0.25 prints as 0.25 rather than ¼",
  },
  {
    n: 7,
    ruling: "9 — a blend of one",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "        if (foldedBlendByDishId.has(dishId)) continue;", to: "        if (false && foldedBlendByDishId.has(dishId)) continue;" }],
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: "the lone paprika gets its own seasonings_dry step again",
  },
  {
    n: 8,
    ruling: "13 — the cook day",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "        ...(lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {}),", to: "        ...(false && lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {})," }],
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: "no daysUntilCook reaches the narration input",
  },
  {
    n: 9,
    ruling: "2 — the absent hold fallback",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    edits: [
      // The phase fallback the old GERUND table had.
      { from: '  rest: "resting",', to: '  rest: "resting",\n  hold: "staying warm",' },
      // And the veto that catches it for a cold dish.
      {
        from: '  if (state === "staying warm" && coldDish) return "chilling";',
        to: '  if (state === "staying warm" && coldDish) return "staying warm";',
      },
    ],
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: 'a cold dish is called "staying warm" again — the pre-B1 GERUND[phaseType] behaviour',
  },
  {
    n: 10,
    ruling: "D-WS9-298 — the cook day is not part of the composition",
    file: join(API, "src/lib/prepWeekAggregation.ts"),
    cwd: API,
    edits: [
      {
        // Put the plan-level date back INSIDE the hashed input.
        from: "      planId: plan.id,\n      planName,\n      meals,\n    },",
        to: "      planId: plan.id,\n      planName,\n      meals,\n      ...({ prepDay } as Record<string, unknown>),\n    },",
      },
      {
        // And the PER-MEAL date, which is the edit that actually moves the
        // fingerprint between two plans that differ only in which day a meal is
        // on. `prepDay` alone does not: both arms of the test share a startDate,
        // so it is the same string in each and only the structural assertion
        // catches it. Both halves of B1's shape have to come back for the
        // behavioural guarantee to break.
        from: "      servingsOverride: item.servingsOverride,\n      dishes,",
        to: "      servingsOverride: item.servingsOverride,\n      ...({ assignedDate: item.assignedDate?.toISOString().slice(0, 10) ?? null } as Record<string, unknown>),\n      dishes,",
      },
    ],
    test: "src/lib/__tests__/prepWeekAggregation.test.ts",
    runner: "api",
    expect: "a day reassignment moves the fingerprint, so the cache misses",
  },
  {
    n: 11,
    ruling: "D-WS9-296 (1) — the component key",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        // Every signal off at once: no componentKey, no role noun, no verb
        // group. Nothing forms a mixture and the marinade scatters into the
        // eight separate portions BUG-338 opened on.
        from: "    let noun: string | null = nounIn(keyText);\n    // Signal 2 — the step's own prose.\n    noun ??= nounIn(st.text);",
        to: "    let noun: string | null = null;",
      },
      {
        from: "    const isCombine = COMBINE_VERB.test(st.text);",
        to: "    const isCombine = false;",
      },
    ],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: "the carne asada marinade scatters into eight portions again",
  },
{
    n: 12,
    ruling: "D-WS9-296 — the bowl name on every destination",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        // The step still groups, but the vessel loses its name — which is the
        // whole of D-WS9-296: a bowl nobody can label is a bowl nobody finds.
        from: "        bowlName: b.bowlName,",
        to: "        // bowlName dropped",
      },
    ],
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: "a component step reaches the narrator with no bowl to name",
  },
  {
    n: 13,
    ruling: "D-WS9-296 ruling 1 — a protein is never a member",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        from: "      if (isProtein(id)) b.cookDay.add(id);",
        to: "      if (false) b.cookDay.add(id);",
      },
    ],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: "raw skirt steak sits in the marinade bowl all week",
  },
  {
    n: 14,
    ruling: "D-WS9-296 ruling 2 — the service-form guard",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        from: "    return SERVICE_FORM.test(blob);",
        to: "    return false;",
      },
    ],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: "the wedged limes are back in the hot-sauce jar",
  },
  {
    n: 15,
    ruling: "D-WS9-299 — prep-worthiness",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        // Everything is prep again, so "measure 2 tbsp hot sauce" is a step.
        from: "  // Proteins are exempt — see `phase` on the input.",
        to: "  return { worthDoingAhead: true, reason: \"mixture\" };\n  // Proteins are exempt — see `phase` on the input.",
      },
    ],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: '"measure 2 tbsp hot sauce" is a prep step again',
  },
  {
    n: 16,
    ruling: "D-WS9-298 (2) — a Friday protein is not prepped on Sunday",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "  if (daysUntilCook <= 2) {",
        to: "  if (daysUntilCook <= 99) {",
      },
    ],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "a salmon cooked in 5 days renders as a step with a 2-day note",
  },
  {
    n: 17,
    ruling: "D-WS9-298 (2) — an unassigned day is not day zero",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "  if (daysUntilCook === undefined) {",
        to: "  if (false) {",
      },
    ],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "an undated chicken step gets the confident 2-day note instead of its own line",
  },
  {
    n: 18,
    ruling: "D-WS9-298 (1) — the model's storage text never reaches the screen",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        // Keep the model's note when it has one — the merge the ruling forbids.
        // H1 moved this line: the flesh classes now read ctx.ingredientNames
        // (BUG-346 a), so the anchor is the three-argument call.
        from: "          storageNote: storageClassFor(ctx.text, ctx.bowlName, ctx.ingredientNames).note,",
        to: "          storageNote: step.storageNote ?? storageClassFor(ctx.text, ctx.bowlName, ctx.ingredientNames).note,",
      },
    ],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "a model-written storage note survives onto the step",
  },
  {
    n: 19,
    ruling: "D-WS9-298 — the overlay is computed, never read from the cache",
    file: join(API, "src/routes/cooking.ts"),
    cwd: API,
    edits: [
      {
        // Serve the cached blob untouched: the shape D-WS9-298 forbids, because
        // the blob holds the dates the plan had when it was generated.
        // H1 wrapped this in summarizePrepWeek (ruling 4's header numbers are
        // computed AFTER the overlay), so the anchor gained a level of nesting.
        from: "          result: summarizePrepWeek(\n            applyStorageOverlay(\n              cached.structureJson as unknown as PrepWeekResult,\n              storageContextFor(),\n            ),\n          ),",
        to: "          result: summarizePrepWeek(cached.structureJson as unknown as PrepWeekResult),",
      },
    ],
    test: "src/routes/__tests__/cooking.test.ts",
    runner: "api",
    expect: "a cache hit serves yesterday's storage notes",
  },
  {
    n: 20,
    ruling: "BUG-340 — the phase classifier's shelf-stable exclusion",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [
      {
        from: "      return SHELF_STABLE_PROTEIN.test(normalizeIngredientName(name))\n        ? pantryPhase()\n        : \"proteins\";",
        to: "      return \"proteins\";",
      },
    ],
    test: "src/lib/__tests__/prepCombineEngine.test.ts",
    runner: "api",
    expect: "anchovy paste goes back into the Proteins phase",
  },
  {
    n: 21,
    ruling: "BUG-340 — the shelf-stable form is subtracted from the contents",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "  const shelfStable = stripShelfStable(identity);\n  const isShelfStable = shelfStable !== identity;",
        to: "  const shelfStable = identity;\n  const isShelfStable = false;",
      },
    ],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "a jar of anchovy paste is told to cook within 2 days",
  },
  {
    n: 22,
    ruling: "BUG-340 — the overlay's own shelf-stable guard, independent of the phase",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        // Only the overlay's guard, leaving the strip in place: the point is
        // that the PHASE alone must not be able to put the raw-flesh line on
        // a jar, the way `Ingredient.category` did.
        from: "        if (ctx.phase === \"proteins\" && !shelfStableHere) {",
        to: "        if (ctx.phase === \"proteins\") {",
      },
    ],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "a miscategorised jar in the Proteins phase gets the 2-day line again",
  },
  {
    n: 23,
    ruling: "BUG-340 (adjacent) — `ham` in the raw-meat class",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [{ from: "|sausages?|bacon|ham|chorizo|", to: "|sausages?|bacon|chorizo|" }],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: "deli ham falls to the 3-day default — the one direction this table may not be wrong in",
  },
  // ── D-WS9-301 — the grouping re-cut ───────────────────────────────────────
  {
    n: 24,
    ruling: "rule 1 — a moment is closed by HEAT",
    file: join(API, "src/lib/prepMoments.ts"),
    cwd: API,
    edits: [
      {
        // Never close a run: every step of a dish becomes one moment, so the
        // slow cooker and the taco look identical.
        from: '    const heat = s.phaseType === HEAT_PHASE;\n    if (!heat && lastWasHeat) run++;',
        to: '    const heat = false;\n    if (!heat && lastWasHeat) run++;',
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "nothing separates a prep run from what happens after the pan is hot",
  },
  {
    n: 25,
    ruling: "rule 1's inverse — the component absorbs its run (the marinade's lemon)",
    file: join(API, "src/lib/prepCombineAdapter.ts"),
    cwd: API,
    edits: [
      {
        from: "          const run = moments.runByIngredientId.get(ing.ingredientId);\n          const shared = run === undefined ? undefined : componentKeyByRun.get(run);\n          if (shared) return `c:${shared}`;",
        to: "          const run = moments.runByIngredientId.get(ing.ingredientId);\n          void run;",
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "the lemon leaves the marinade and is prepped into a second container",
  },
  {
    n: 26,
    ruling: "rule 2 — an all-dry component absorbs nothing fresh (the taco onion)",
    file: join(API, "src/lib/prepCombineAdapter.ts"),
    cwd: API,
    edits: [
      {
        from: "          if (allDry) continue;",
        to: "          if (false && allDry) continue;",
      },
      // 🔴 THREE GUARDS NOW, and H6.1 added two of them. The taco onion is kept out
      // of the spice blend by `allDry`, by signal 4's member-name scrub, and by
      // ruling 3's override scoping — it has a cook step naming it, so it is never a
      // run neighbour. The other two come off here or `allDry` is not what is being
      // tested.
      {
        from: "          if (resolvedKey !== null && !resolvedKey.startsWith(\"r:\")) return resolvedKey;",
        to: "          void resolvedKey;",
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "the diced onion is swallowed by the taco seasoning blend",
  },
  {
    n: 27,
    ruling: "rule 4 — ground meat is never touched",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [{ from: "  if (isGroundMeat(group.ingredientName)) return \"exclude\";", to: "" }],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: '"Portion the ground beef" comes back',
  },
  {
    n: 28,
    ruling: "rule 5 — a shared ingredient is ONE container, never one per dish",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        // D-WS9-301 rule 11(a) replaced H1's flat refusal with a deferral, so
        // the break is now "let a shared ingredient bucket immediately" — which
        // is precisely the shape H1 measured going wrong.
        from: "          if (!isAuthoredMixture && isShared) {\n            deferredShared.push({ dishId: c.dishId, momentKey: mk, entry, phase: phase.phase, mealId: c.mealId });\n            continue;\n          }",
        to: "          void isAuthoredMixture; void isShared; void deferredShared;",
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "rule 1 splits the garlic three ways, one single-dish container each",
  },
  {
    n: 29,
    ruling: "rule 7 — the drop pass STOPS after two classes",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        // Let it reach everything, which is the loop Hans ruled against.
        from: '    .filter((x): x is { s: PlannedStep; cls: "garnish" | "citrus-wedge" } => x.cls !== null && !x.s.demoted)',
        to: '    .map((x) => ({ s: x.s, cls: (x.cls ?? "garnish") as "garnish" | "citrus-wedge" }))\n    .filter((x) => !x.s.demoted)',
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "the pass deletes real knife work to force the count under 15",
  },
  {
    n: 30,
    // H2 moved the ROUND-UP into prepStepMinutes.planMinutes, where break 35 now
    // pins it. What summarizePrepWeek still owns is the exclusion: a demoted step
    // is neither a container nor a minute.
    ruling: "ruling 4 — a demoted step counts for nothing in the header",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      if (step.skipSuggested) continue;", to: "      if (false && step.skipSuggested) continue;" }],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "a dropped garnish portion is counted as a container the cook does not have",
  },
  {
    n: 31,
    ruling: "BUG-346 (a) — the flesh check reads identity, not a note",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "  const identity = ingredientNames ? ingredientNames.join(\" \") : contents;",
        to: "  const identity = contents;",
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: '"baking soda (for tenderizing beef)" is told to cook within 2 days',
  },
  {
    n: 32,
    ruling: "rule 8 — a container is named by dish and use, never numbered",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [{ from: "    if (fallbackUse) return `${dish} ${fallbackUse}`;", to: "" }],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: '"Slow-Cooker Chicken bowl 1" comes back',
  },
  // ── H2 — honest minutes, and two leave-behinds ────────────────────────────
  {
    n: 33,
    ruling: "BUG-204 — the step minutes are the ENGINE's, not the model's",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "      estimatedMinutes: planned.estimatedMinutes, // CODE (BUG-204 — prepStepMinutes.ts)",
        to: "      estimatedMinutes: prose.estimatedMinutes ?? planned.estimatedMinutes,",
      },
      {
        from: "    total += planned.estimatedMinutes;",
        to: "    total += prose.estimatedMinutes ?? planned.estimatedMinutes;",
      },
    ],
    test: "src/lib/__tests__/prepWeekAssembly.test.ts",
    runner: "api",
    expect: "the model's inflated estimate moves the total again",
  },
  {
    n: 34,
    ruling: "BUG-204 — the cap REPORTS a classification error, it does not hide it",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [{ from: "    overCap: raw > MINUTES.stepCap,", to: "    overCap: false," }],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "a 40-minute step is silently flattened to 15 with nothing to chase",
  },
  {
    n: 35,
    ruling: "BUG-204 — the header rounds UP, and the overhead is applied once",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [
      {
        from: "  return Math.ceil(withOverhead / 5) * 5;",
        to: "  return Math.floor(withOverhead / 5) * 5;",
      },
    ],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "a stated number the cook misses — the direction Hans's condition forbids",
  },
  {
    n: 36,
    ruling: "H2.2 — a dry noun never names a container holding fresh food",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        from: "    const noun = hasFresh && b.noun !== null && DRY_NOUNS.has(norm(b.noun)) ? null : b.noun;",
        to: "    const noun = b.noun;",
      },
    ],
    test: "src/lib/__tests__/prepComponents.test.ts",
    runner: "api",
    expect: '"Tex-Mex Seasoned Ground Beef seasoning" holds a diced onion again',
  },
  {
    n: 38,
    ruling: "H2.2 second half — the name is re-checked where the membership is final",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "    if (b.bowlName === \"\" || !DRY_BOWL_NOUN.test(b.bowlName)) continue;",
        to: "    if (true || b.bowlName === \"\") continue;",
      },
    ],
    test: "src/lib/__tests__/prepMoments.test.ts",
    runner: "api",
    expect: "a container the ADAPTER absorbed garlic into keeps its spice-blend name",
  },
  {
    n: 37,
    ruling: "H2.3 — a demoted step carries no storage note",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [{ from: "        if (step.skipSuggested) {", to: "        if (false && step.skipSuggested) {" }],
    test: "src/lib/__tests__/prepStorage.test.ts",
    runner: "api",
    expect: '"Skip this one and do it at the stove. » Airtight in the fridge" comes back',
  },
  // ── H2b — the two measured inflations ─────────────────────────────────────
  {
    n: 39,
    ruling: "H2b 1 — a shared container's knife work is costed ONCE",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [
      {
        // Stop the per-dish measures from folding into one amount. The last
        // measure then overwrites rather than summing, so 2½ onions is costed as
        // the ½ onion of the final share — a visibly wrong total either way, and
        // deterministic, which a `Math.random()` key would not have been.
        from: "      const prev = byUnit.get(key);",
        to: "      const prev = undefined as undefined | { quantity: number; amount: string; note: string };",
      },
    ],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "the per-dish split is charged as separate cuts again",
  },
  {
    n: 40,
    ruling: "H2b 2 — juice and zest are charged on the FRUIT COUNT",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [
      { from: "      const viaYield = yieldFor?.(ingredientName) ?? null;", to: "      const viaYield = null as null | { yield: SourceYieldLike | null; count: (q: number | null, u: string | null) => number | null };" },
    ],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "3 tbsp of lime juice falls back to a made-up figure",
  },
  {
    n: 41,
    ruling: "H2b 2 — one lime is one lime, zested AND juiced",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [
      { from: "    if (group.length < 2) continue;", to: "    if (group.length < 2 || true) continue;" },
    ],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "zesting and juicing one lime is charged twice",
  },
  // ── D-WS9-301 rules 9-14 — the October 1 device pass ──────────────────────
  {
    n: 42,
    ruling: "rule 9 — the phases are the kind of work, in work order",
    file: join(API, "src/lib/ai/schemas/prepWeek.ts"),
    cwd: API,
    edits: [
      {
        from: '      "seasonings_dry",\n      "produce",\n      "sauces_marinades",\n      "proteins",',
        to: '      "seasonings_dry",\n      "sauces_marinades",\n      "produce",\n      "proteins",',
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "sauces come before produce again — the aisle order, not the board order",
  },
  {
    n: 43,
    ruling: "rule 9 — the labels Hans gave",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: 'seasonings_dry: { title: "Dry ingredients", skippable: true },',
        to: 'seasonings_dry: { title: "Seasonings & dry ingredients", skippable: true },',
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "the old aisle label comes back",
  },
  {
    n: 44,
    ruling: "rule 10 — produce opens with the wash step",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: '    if (key === "produce" && !washEmitted) {', to: "    if (false) {" }],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "no wash step, and the phase opens on a knife",
  },
  {
    n: 45,
    ruling: "rule 10 — the wash step is not a container and does not gate prepped",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      { from: "    if (s.demoted || s.cookDaySentence || s.holdsNoContainer) continue;", to: "    if (s.demoted || s.cookDaySentence) continue;" },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "the wash step is counted as a container in the header",
  },
  {
    n: 46,
    ruling: "rule 10 — the wash step's prose is the engine's, not the model's",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "    steps: steps.filter((s) => !s.fixedProse).map((s) => ({",
        to: "    steps: steps.map((s) => ({",
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "the wash step is sent to the narrator, which can then get it wrong",
  },
  {
    n: 47,
    ruling: "rule 11 — a portion names its destination container",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "  const destinationFor: DestinationResolver = (dishId, ingredientId) =>",
        to: "  const destinationFor: DestinationResolver = () => undefined; const _unused = (dishId: string, ingredientId: string | null) =>",
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: '"¾ onion" with no statement of ¾ into WHAT',
  },
  {
    n: 48,
    ruling: "rule 12 — a protein step names the action, and the PROSE wins",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [
      {
        // Note first instead of prose first: the Buttermilk chicken reads
        // "sliced very thin" when the cook step expects it pounded.
        from: "  const fromProse = PROTEIN_VERBS.filter(([re]) => re.test(prose)).map(([, v]) => v);\n  if (fromProse.length > 0) return fromProse.slice(0, 2);",
        to: "  const fromProseIgnored = PROTEIN_VERBS.filter(([re]) => re.test(prose)).map(([, v]) => v);\n  void fromProseIgnored;",
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "the shopping form wins over the action the cook step expects",
  },
  {
    n: 49,
    ruling: "rule 13 — the held list, and its evaluation order",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "      const steps = phase.steps.map((step) => {",
        to: "      const steps: typeof phase.steps = []; const _late = phase.steps.map((step) => {",
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "the phase is built before its own steps have run",
  },
  {
    n: 50,
    ruling: "rule 13 — the no-cook-days line",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [
      {
        from: "          ? { note: anyDayKnown ? PROTEINS_PHASE_NOTE : `${PROTEINS_PHASE_NOTE} ${NO_COOK_DAYS_NOTE}` }",
        to: "          ? { note: PROTEINS_PHASE_NOTE }",
      },
    ],
    test: "src/lib/__tests__/prepPhases.test.ts",
    runner: "api",
    expect: "a plan with no cook days is never told how to get them",
  },
  {
    n: 51,
    ruling: "rule 14 — the source parenthetical stays gone",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        // Put the parenthetical back on EVERY measure builder (there are three,
        // and the test asserts over the whole narration input, so one is enough
        // to go red — but all three is the honest reinstatement of the defect).
        from: "        ...(destinationFor ? { destination: destinationFor(c.dishId, entry.ingredientId) } : {}),",
        to: "        ...({ fromSource: sourceCountFor(entry.sourceYield, c.quantity, c.unit) } as object),",
      },
    ],
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: '"(from 2 limes)" comes back onto the card',
  },
  {
    n: 52,
    ruling: "H3 item 14 — the lag follows the day NAME",
    file: join(API, "src/lib/prepWeekAggregation.ts"),
    cwd: API,
    edits: [
      {
        from: "      const cookMs = startMs + ((dow - startDow + 7) % 7) * DAY_MS;",
        to: "      const cookMs = prepMs + DAY_MS; void dow; void startDow;",
      },
    ],
    test: "src/lib/__tests__/prepWeekAggregation.test.ts",
    runner: "api",
    expect: "every meal is one day out however Plan Review moves it",
  },
  {
    n: 53,
    ruling: "11(c)/H6.2 — knife work is never claimed into a container step",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "          const kind = kindOf(entry);\n          if (kind === \"dry\" || kind === \"wet\") {\n            claimed.add(`${c.dishId}|${entry.ingredientId}`);\n          }", to: "          claimed.add(`${c.dishId}|${entry.ingredientId}`);" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "the marinade minces its own garlic again — Hans's objection, restored",
  },
  {
    n: 54,
    ruling: "11(c) — a container never has a step in Produce",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      if (key === \"produce\" || key === \"proteins\") continue;\n      const mine = [...b.entries.values()].filter(", to: "      if (key === \"proteins\") continue;\n      const mine = [...b.entries.values()].filter(" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "\"Build the … container\" comes back to the middle of the knife work",
  },
  {
    n: 55,
    ruling: "11(c) — the phase takes only its own kind of work",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      const mine = [...b.entries.values()].filter(\n        (e) => PHASE_OF_KIND[kindOf(e)] === key,\n      );", to: "      const mine = [...b.entries.values()];" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "every container step holds all five members, dry spice beside wet oil",
  },
  {
    n: 56,
    ruling: "11(c) — the finishing step says what is already in the bowl",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "        ...(alreadyIn.length > 0 ? { containerHolds: alreadyIn } : {}),", to: "        ...(false ? { containerHolds: alreadyIn } : {})," }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "the cook pours oil into a bowl the screen never says has anything in it",
  },
  {
    n: 57,
    ruling: "H5.3 — the FORM decides a member's kind",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "  if (WET_FORM.test(ingredientName)) return \"wet\";", to: "  void WET_FORM;" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "a bottle of lime juice is treated as knife work and never reaches the sauces phase",
  },
  {
    n: 58,
    ruling: "11(c)/H6.1-B — one container, however many steps touch it",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      for (const n of here) names.add(n);", to: "      unnamed += here.length;" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "the header counts a container once per step again — the number Hans has to trust",
  },
  {
    n: 59,
    ruling: "H6.1-B — a step counts the containers it FILLS, not only its own",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "  for (const c of step.components) {\n    for (const m of c.measures) if (m.destination) names.add(m.destination);\n  }",
        to: "  void step.components;",
      },
    ],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "every tub the cook fills drops out of the count, and only the authored mixtures are left",
  },
  {
    n: 60,
    ruling: "11(c) — the mixture is measured over the WHOLE container",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      const surviving = [...b.entries.values()]\n        .flatMap((e) => componentsForDish(e, b.dishId, destinationFor))", to: "      const surviving = mine\n        .flatMap((e) => componentsForDish(e, b.dishId, destinationFor))" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "a marinade with one oil in phase 3 dissolves, and the liquids are never poured",
  },
  {
    n: 61,
    ruling: "G1 — the day-dependent lines are recomputed on the cache HIT",
    file: join(API, "src/routes/cooking.ts"),
    cwd: API,
    edits: [{ from: "          result: summarizePrepWeek(\n            applyStorageOverlay(\n              cached.structureJson as unknown as PrepWeekResult,\n              storageContextFor(),\n            ),\n          ),", to: "          result: cached.structureJson as unknown as PrepWeekResult," }],
    test: "src/routes/__tests__/cooking.test.ts",
    runner: "api",
    expect: "a hit serves yesterday's storage notes and the header's two numbers go missing entirely",
  },
  {
    n: 62,
    ruling: "H5.3 — there is no note arm, and it must not come back",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "  if (WET_FORM.test(ingredientName)) return \"wet\";\n  void preparationNotes;", to: "  if (WET_FORM.test(ingredientName)) return \"wet\";\n  if (/\\b(zest\\w*|juic\\w*|squeez\\w*)\\b/i.test(preparationNotes)) return \"wet\";" }],
    test: "src/lib/__tests__/prepContainers.test.ts",
    runner: "api",
    expect: "a whole lemon is zested and juiced inside the marinade bowl again, and the grated cucumber with it",
  },
  {
    n: 63,
    ruling: "H5.0 — the prep session cannot happen in the past",
    file: join(API, "src/lib/prepWeekAggregation.ts"),
    cwd: API,
    edits: [{ from: "  const prepDay = startIso === null ? null : startIso > todayIso ? startIso : todayIso;", to: "  const prepDay = startIso;" }],
    test: "src/lib/__tests__/prepWeekAggregation.test.ts",
    runner: "api",
    expect: "the chicken Hans cooks tomorrow reads 3 days out and the Proteins phase empties itself",
  },
  {
    n: 64,
    ruling: "H5.0 — the lag is measured from the prep day, not the weekday offset",
    file: join(API, "src/lib/prepWeekAggregation.ts"),
    cwd: API,
    edits: [{ from: "      lagByMealId.set(mealId, Math.max(0, Math.round((cookMs - prepMs) / DAY_MS)));", to: "      lagByMealId.set(mealId, Math.max(0, Math.round((cookMs - startMs) / DAY_MS)));" }],
    test: "src/lib/__tests__/prepWeekAggregation.test.ts",
    runner: "api",
    expect: "the anchor is computed and then ignored — the same inflated lag by another route",
  },
  {
    n: 65,
    ruling: "H5.1 — a dish that IS the toppings forms no component",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [{ from: "  if (isServedSeparately(dishTitle)) {\n    return { components: [], byIngredient: new Map() };\n  }", to: "  void isServedSeparately;" }],
    test: "src/lib/__tests__/prepServedSeparately.test.ts",
    runner: "api",
    expect: "\"Taco Toppings sauce jar\" returns — five things set out in five dishes, stirred into one",
  },
  {
    n: 66,
    ruling: "H5.1 — …and the MOMENT route cannot rebuild it",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "          if (isServedSeparately(c.dishName)) continue;", to: "          void isServedSeparately;" }],
    test: "src/lib/__tests__/prepServedSeparately.test.ts",
    runner: "api",
    expect: "the run grouping rebuilds the bucket and rule 8 names it \"Taco Toppings prep container\"",
  },
  {
    n: 67,
    ruling: "H5.3 — the service portion is not prep",
    file: join(API, "src/lib/prepCombineAdapter.ts"),
    cwd: API,
    edits: [{ from: "  if (!purposeSomewhere) return unchanged;", to: "  if (!purposeSomewhere || true) return unchanged;" }],
    test: "src/lib/__tests__/prepServedSeparately.test.ts",
    runner: "api",
    expect: "the cook is told to slice 2 lemons into rounds on Sunday for a Thursday dinner",
  },
  {
    n: 68,
    ruling: "H5.2 — a finished step ends in the fridge",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      ...(workedAgainAfter(s) ? { setAsideFor: workedAgainAfter(s)! } : {}),", to: "      ...(s.containerId ? { setAsideFor: \"sauces and marinades\" } : {})," }],
    test: "src/lib/__tests__/prepServedSeparately.test.ts",
    runner: "api",
    expect: "the FINISHING step is told to set its bowl aside, contradicting the fridge line beneath it",
  },
  {
    n: 69,
    ruling: "H6.1-1 — prep groups by the FOOD, not the catalog row",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [{ from: "      ? (foldedIdByIngredientId.get(ing.ingredientId) ?? ing.ingredientId)\n      : ingredientGroupKey(ing.ingredientName);", to: "      ? ing.ingredientId\n      : ing.ingredientId;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "garlic is two steps again — 10 cloves on one and 17 on another",
  },
  {
    n: 70,
    ruling: "H6.1-1 — the singular clove folds",
    file: join(API, "src/lib/groceryStaples.ts"),
    cwd: API,
    edits: [{ from: "  \"garlic clove\": \"garlic\",", to: "  \"garlic clove_disabled\": \"garlic\"," }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "a recipe written \"1 garlic clove\" gets its own basket line and its own prep step",
  },
  {
    n: 71,
    ruling: "H6.1-1 — a merged group reconciles its units",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [{ from: "    if (!/^(?:cloves?|heads?|stalks?|sprigs?|ears?|slices?)$/i.test(unit.trim())) continue;", to: "    continue;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "the merged garlic keeps two lines and the unitless one is charged as ONE clove",
  },
  {
    n: 72,
    ruling: "H6.1-2 — a bare count on a clove-shaped name is a clove count",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [{ from: "      quantity != null && quantity > 0 && (unitSaysCloves || (nameSaysCloves && unit == null))", to: "      quantity != null && quantity > 0 && unitSaysCloves" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "27 cloves cost 20 seconds",
  },
  {
    n: 73,
    ruling: "H6.1-2 — a celery stalk is not an onion",
    file: join(API, "src/lib/prepStepMinutes.ts"),
    cwd: API,
    edits: [{ from: "  for (const [re, rate] of CUT_RATES) {", to: "  if (name) return MINUTES.perCutVegetable;\n  for (const [re, rate] of CUT_RATES) {" }],
    test: "src/lib/__tests__/prepStepMinutes.test.ts",
    runner: "api",
    expect: "3 celery stalks read 7½ minutes again, the same as 3 onions",
  },
  {
    n: 74,
    ruling: "H6.1-3 — signal 4 does not read one food's name out of another's",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [{ from: "      if (texts.some((t) => re.test(scrub(t)))) { b.members.add(ing.ingredientId); break; }", to: "      if (texts.some((t) => re.test(norm(t)))) { b.members.add(ing.ingredientId); break; }" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "the diced onion and minced garlic are conscripted into the spice blend by \"onion powder\" and \"garlic powder\"",
  },
  {
    n: 75,
    ruling: "H6.1-3 — a cook step beats the run proxy",
    file: join(API, "src/lib/prepMoments.ts"),
    cwd: API,
    edits: [{ from: "    entryStep.set(ing.ingredientId, named.stepIndex);\n    overrides.push({", to: "    if (wasRun !== null) { overrides.push({ ingredientName: ing.ingredientName, stepIndex: named.stepIndex, wasRunMoment: wasRun, prose: named.text.slice(0, 90) }); continue; }\n    entryStep.set(ing.ingredientId, named.stepIndex);\n    overrides.push({" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "the H1 narrowing returns: 412 overrides overruled by a proxy, and the taco onion back in the spice run",
  },
  {
    n: 76,
    ruling: "H6.1-B — every portion names a container",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "    return (\n      sharedLabel.get(`${dishId}|${ingredientId}`) ??\n      loneLabel.get(`${dishId}|${ingredientId}`)\n    );", to: "    return undefined;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "Hans's original complaint returns — \"they don't say where to put the veggie\"",
  },
  {
    n: 77,
    ruling: "H6.1-C — the dish name never selects a storage class",
    file: join(API, "src/lib/prepStorage.ts"),
    cwd: API,
    edits: [{ from: "  void bowlName;\n  const identity = ingredientNames ? ingredientNames.join(\" \") : contents;\n  const shelfStable = stripShelfStable(identity);", to: "  const identity = ingredientNames ? ingredientNames.join(\" \") : contents;\n  const shelfStable = stripShelfStable(`${identity} ${bowlName}`);" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "a bowl of flour is classed as cut chillies because the dish is called Jalapeño Cheddar Cornbread",
  },
  {
    n: 78,
    ruling: "H6.2-1 — one container per dish and moment for lone produce",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "              momentKey: phase.phase,", to: "              momentKey: `${phase.phase}|${entry.ingredientId}`," }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "one tub per ingredient returns — 17 single-member containers out of 28 on Hans's plan",
  },
  {
    n: 79,
    ruling: "H6.2-1 — a bowl that holds one portion is not a bowl",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      if (distinct < floor) continue;", to: "      if (distinct < 0) continue;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "a single lone portion is wrapped in a labelled tub again, and a 2-spice dry blend with it",
  },
  {
    n: 80,
    ruling: "H6.2-2 — a portion that needs no action is not prep",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [{ from: "        if (isNoWorkPortion(ing.preparationNote)) continue;", to: "        void isNoWorkPortion;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "3 whole unpeeled cloves get a labelled tub on Sunday so they can come out of it on Thursday",
  },
  {
    n: 81,
    ruling: "H6.2-4 — whole-protein knife work always reaches phase 4",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "          const kind = kindOf(entry);\n          if (kind === \"dry\" || kind === \"wet\") {", to: "          const kind = kindOf(entry);\n          if (kind !== \"produce\") {" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "a protein that shares a cook sentence with its aromatics loses its trim step entirely",
  },
  {
    n: 82,
    ruling: "H6.2-5 — a produce step carries no close of its own",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "    if (!step.containerId && !step.bowlName) return null;", to: "    void step;" }],
    test: "src/lib/__tests__/prepServedSeparately.test.ts",
    runner: "api",
    expect: "a step pouring into six containers says \"Set aside for the sauces step\" about somebody else's bowl",
  },
  {
    n: 83,
    ruling: "H6.2 follow-up — a member that goes in later leaves the bowl",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "      if (later.length === 0) continue;", to: "      if (later.length >= 0) continue;" }],
    test: "src/lib/__tests__/prepIdentityAndNames.test.ts",
    runner: "api",
    expect: "the blender's cilantro rides on the roasting tray and the cook has to pick it back out",
  },
  // ── [prepcook] H7 — Hans's October 2 ruling, one break per test ─────────────
  {
    n: 84,
    ruling: "H7 1 — no container mixes classes A/B/C",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: '    if (p.cls === "B") return heat ? "B" : null;', to: '    if (p.cls === "B") return heat ? "A" : null;' }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the taco pan's diced onion joins its spice blend — a vegetable in a seasoning container",
  },
  {
    n: 85,
    ruling: "H7 2 — a serve-time step groups nothing",
    file: join(API, "src/lib/prepMoments.ts"),
    cwd: API,
    edits: [
      {
        from: "    if (!isHeatMoment(named, ordered)) {\n      serveStep.set(ing.ingredientId, named.stepIndex);\n      continue;\n    }",
        to: "    void serveStep;",
      },
    ],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the table-side toss becomes a moment and the tomatoes and cucumber share a container",
  },
  {
    n: 86,
    ruling: "H7 3 (2a) — a lone cut portion gets a `<Dish> — <item>` container",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "            dishes.length > 1 ? containerLabel(upperFirst(noun), dishes) : containerLabel(p.dishName, [noun]);",
        to: "            dishes.length > 1 ? containerLabel(upperFirst(noun), dishes) : (undefined as unknown as string);",
      },
    ],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the cornbread's diced jalapeño has no lid again",
  },
  {
    n: 87,
    ruling: "H7 4 (2b) — every container closes exactly once, on its last step",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "    const last = l[l.length - 1];\n    last.closes", to: "    const last = l[0];\n    last.closes" }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the slow cooker's vegetables are closed by the FIRST knife step, before the carrots go in",
  },
  {
    n: 88,
    ruling: "H7 5 (2c) — a heated step is never prep",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: '        if (!worked) planned.demoted = { reason: "heat-or-no-knife-work" };', to: "        void worked;" }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "'Brown the Italian sausage' is back on the prep list",
  },
  {
    n: 89,
    ruling: "H7 6 (2c) — a single-item measure is never prep",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: '          measured <= 1 ? "single-item" : "below-floor-or-not-one-moment",', to: "          undefined," }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the lone hot sauce and the two-item Alfredo 'seasoning' are prep again",
  },
  {
    n: 90,
    ruling: "H7 7 (2c) — the narrator cannot flip skipSuggested",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "      // D-WS9-301 rule 7 — the engine's own demotion has to reach the wire, not",
        to: "      ...(prose.skipSuggested ? { skipSuggested: true } : {}),\n      // D-WS9-301 rule 7 — the engine's own demotion has to reach the wire, not",
      },
    ],
    test: "src/lib/__tests__/prepWeekAssembly.test.ts",
    runner: "api",
    expect: "the model's demotion of the cubed chuck reaches the wire",
  },
  {
    n: 91,
    ruling: "H7 8 (2d) — one produce step per food, citrus included",
    file: join(API, "src/lib/prepClasses.ts"),
    cwd: API,
    edits: [{ from: "  const base = sourceYield?.fromName ?? ingredientName;", to: "  const base = ingredientName;" }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the lemon is zested in one step and juiced in two more",
  },
  {
    n: 92,
    ruling: "H7 8 (2d) — the parsley pair folds when the grocery lane folds it",
    file: join(API, "src/lib/ingredientRelations.ts"),
    cwd: API,
    edits: [{ from: '  return v.kind === "admit" ? { target: v.target, member: v.member } : null;', to: "  void v;\n  return null;" }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "fresh parsley and fresh flat-leaf parsley are two steps again",
  },
  {
    n: 93,
    ruling: "H7 9 (2e) — no condiment in the dry phase",
    file: join(API, "src/lib/prepCombineEngine.ts"),
    cwd: API,
    edits: [
      {
        from: '    if (purchaseUnit && WET_PACKS.has(purchaseUnit.trim().toLowerCase())) return "sauces_marinades";\n',
        to: "",
      },
    ],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "dijon and mayonnaise are measured with the dry spices again",
  },
  {
    n: 94,
    ruling: "H7 10 (2f) — the 'already in it' list equals the container's members",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: "    if (holds.length > 0) st.containerHolds = holds;",
        to: '    if (holds.length > 0) st.containerHolds = [...holds, "baby Yukon gold potatoes"];',
      },
    ],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the potatoes moved to cook day are 'already in it' again",
  },
  {
    n: 95,
    ruling: "H7 10 (2f) — the closing verb is the code's",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [
      {
        from: '        st.closingLine = emulsion ? "Whisk to combine." : "Stir to combine.";',
        to: '        st.closingLine = emulsion ? "Toss to coat." : "Stir to combine.";',
      },
    ],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "a bowl of oil, lemon and aromatics is told to 'toss to coat'",
  },
  {
    n: 96,
    ruling: "H7 found — a weight is not the verb 'pound'",
    file: join(API, "src/lib/prepComponents.ts"),
    cwd: API,
    edits: [{ from: "  [/(?<![\\d½¼¾⅓⅔⅛⅜⅝⅞]\\s?|\\b(?:a|one|two|three|four|half a)\\s)\\bpound(?:s|ed|ing)?\\b/i, \"pound\"],", to: "  [/\\bpound(?:s|ed|ing)?\\b/i, \"pound\"]," }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "'1½ pounds shrimp' becomes 'Pound the shrimp' again",
  },
  {
    n: 97,
    ruling: "H7 found — a cook-day line only into a bowl that exists",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    edits: [{ from: "          const bowl = c.cookDayInto ? liveBowl.get(`${c.dishId}|${c.cookDayInto}`) : undefined;", to: "          const bowl = c.cookDayInto ?? undefined;" }],
    test: "src/lib/__tests__/prepClassesH7.test.ts",
    runner: "api",
    expect: "the Alfredo chicken goes 'into the Alfredo seasoning' that no longer exists",
  },
];

function runTest(b: Break): { pass: boolean; tail: string } {
  const args =
    b.runner === "api"
      ? ["--env-file=.env", "--import", "tsx", "--test", b.test]
      : [
          "--experimental-strip-types",
          "--no-warnings",
          "--import",
          "./lib/api/__tests__/_setup.mjs",
          "--test",
          b.test,
        ];
  try {
    execFileSync(process.execPath, args, {
      cwd: b.cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, TZ: "UTC" },
    });
    return { pass: true, tail: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const failing = out
      .split("\n")
      .filter((l) => /^✖ |AssertionError|not ok/.test(l.trim()))
      .slice(0, 3)
      .map((l) => l.trim())
      .join(" | ");
    return { pass: false, tail: failing };
  }
}

const results: string[] = [];
let allRed = true;

// H7 — `--only=H7` runs one round's breaks. An earlier round's anchors can move with
// a later round's rewrite; that is reported by a full run, not hidden by a filter.
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const SELECTED = ONLY ? BREAKS.filter((b) => b.ruling.startsWith(ONLY)) : BREAKS;

for (const b of SELECTED) {
  const original = readFileSync(b.file, "utf8");
  const before = sha(original);
  const missing = b.edits.filter((e) => !original.includes(e.from));
  if (missing.length > 0) {
    results.push(
      `BREAK ${b.n} (${b.ruling}) — ⚠️ ANCHOR MISSING in ${b.file.replace(API, "api-server").replace(KIWI, "kiwi")} (${missing.length} of ${b.edits.length}); break NOT RUN`,
    );
    allRed = false;
    continue;
  }
  // Baseline: the test must be GREEN before the break, or the break proves nothing.
  const baseline = runTest(b);
  let broken_src = original;
  for (const e of b.edits) broken_src = broken_src.replace(e.from, e.to);
  writeFileSync(b.file, broken_src);
  const broken = runTest(b);
  writeFileSync(b.file, original);
  const after = sha(readFileSync(b.file, "utf8"));

  const restored = before === after;
  const red = baseline.pass && !broken.pass;
  if (!red) allRed = false;
  results.push(
    [
      `BREAK ${b.n} (ruling ${b.ruling})`,
      `  file      ${b.file.replace(API, "api-server").replace(KIWI, "kiwi")}`,
      `  expected  ${b.expect}`,
      `  baseline  ${baseline.pass ? "GREEN" : `NOT GREEN — ${baseline.tail}`}`,
      `  broken    ${broken.pass ? "🔴 STILL GREEN — the test does not pin this fix" : `RED — ${broken.tail}`}`,
      `  sha256    ${before.slice(0, 16)} → ${after.slice(0, 16)}  ${restored ? "RESTORED" : "🔴 NOT RESTORED"}`,
    ].join("\n"),
  );
}

console.log(results.join("\n\n"));
console.log(`\n${allRed ? `All ${SELECTED.length} breaks RED and restored.` : "⚠️ NOT every break was red — see above."}`);
if (!allRed) process.exitCode = 1;
