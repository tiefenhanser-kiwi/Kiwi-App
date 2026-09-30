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
        from: "    let noun: string | null = st.componentKey ? nounIn(st.componentKey.replace(/[-_]+/g, \" \")) : null;\n    // Signal 2 — the step's own prose.\n    noun ??= nounIn(st.text);",
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
        from: "        return { ...step, storageNote: storageClassFor(ctx.text).note };",
        to: "        return { ...step, storageNote: step.storageNote ?? storageClassFor(ctx.text).note };",
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
        from: "          result: applyStorageOverlay(\n            cached.structureJson as unknown as PrepWeekResult,\n            storageContextFor(),\n          ),",
        to: "          result: cached.structureJson as unknown as PrepWeekResult,",
      },
    ],
    test: "src/routes/__tests__/cooking.test.ts",
    runner: "api",
    expect: "a cache hit serves yesterday's storage notes",
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

for (const b of BREAKS) {
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
console.log(`\n${allRed ? `All ${BREAKS.length} breaks RED and restored.` : "⚠️ NOT every break was red — see above."}`);
if (!allRed) process.exitCode = 1;
