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
  from: string;
  to: string;
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
    from: "export const LAG_AFTER_HEAT_REST = 2;\nexport const LAG_AFTER_HEAT_OTHER = 5;",
    to: "export const LAG_AFTER_HEAT_REST = Infinity;\nexport const LAG_AFTER_HEAT_OTHER = Infinity;",
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "the Carne Asada rest gap returns to 20 min",
  },
  {
    n: 2,
    ruling: "2 — the cue's state",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    from: '  if (state === "staying warm" && coldDish) return "chilling";',
    to: '  if (state === "staying warm" && coldDish) return "staying warm";',
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: '"staying warm" is said of a refrigerated guacamole',
  },
  {
    n: 3,
    ruling: "2 — the tie",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    from: "    (o, oIdx) =>\n      oIdx < seqIdx &&\n      o.dishId !== w.dishId &&",
    to: "    (o, _oIdx) =>\n      o.dishId !== w.dishId &&",
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "a cue points forward at a step the cook has not begun",
  },
  {
    n: 4,
    ruling: "3 — cold dishes forward",
    file: join(API, "src/lib/cookingScheduler.ts"),
    cwd: API,
    from: "  if (COLD_DISH_EXCEPTION.test(title)) return false;\n  return COLD_DISH_TITLE.test(title);",
    to: "  if (COLD_DISH_EXCEPTION.test(title)) return false;\n  return false;",
    test: "src/lib/__tests__/cookingSchedulerBug337.test.ts",
    runner: "api",
    expect: "pico is finish-aligned again and the marinade window stays empty",
  },
  {
    n: 5,
    ruling: "5 — the third clock",
    file: join(KIWI, "lib/cooking/stepTiming.ts"),
    cwd: KIWI,
    from: "  const step = steps[Math.max(0, fromIndex)];\n  const off = step?.startOffsetMinutes;\n  if (off == null) return null;\n  return Math.max(0, -off);",
    to: "  void steps;\n  void fromIndex;\n  return null;",
    test: "lib/cooking/__tests__/cookClockBug337.test.ts",
    runner: "kiwi",
    expect: "the footer falls back to the flat sum and reads 116 for the Carne Asada",
  },
  {
    n: 6,
    ruling: "7 — glyphs and counts",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    from: "  if (best === null) return String(Number(q.toFixed(2)));\n  return mixedNumber(whole, best.glyph);",
    to: "  void best;\n  return String(Number(q.toFixed(2)));",
    test: "src/lib/__tests__/prepWeekAssembly.test.ts",
    runner: "api",
    expect: "0.25 prints as 0.25 rather than ¼",
  },
  {
    n: 7,
    ruling: "9 — a blend of one",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    from: "        if (foldedBlendByDishId.has(dishId)) continue;",
    to: "        if (false && foldedBlendByDishId.has(dishId)) continue;",
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: "the lone paprika gets its own seasonings_dry step again",
  },
  {
    n: 8,
    ruling: "13 — the cook day",
    file: join(API, "src/lib/prepWeekAssembly.ts"),
    cwd: API,
    from: "        ...(lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {}),",
    to: "        ...(false && lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {}),",
    test: "src/lib/__tests__/prepWeekAssemblyBug338.test.ts",
    runner: "api",
    expect: "no daysUntilCook reaches the narration input",
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
  if (!original.includes(b.from)) {
    results.push(`BREAK ${b.n} (${b.ruling}) — ⚠️ ANCHOR MISSING in ${b.file.replace(API, "api-server").replace(KIWI, "kiwi")}; break NOT RUN`);
    allRed = false;
    continue;
  }
  // Baseline: the test must be GREEN before the break, or the break proves nothing.
  const baseline = runTest(b);
  writeFileSync(b.file, original.replace(b.from, b.to));
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
console.log(`\n${allRed ? "All 8 breaks RED and restored." : "⚠️ NOT every break was red — see above."}`);
if (!allRed) process.exitCode = 1;
