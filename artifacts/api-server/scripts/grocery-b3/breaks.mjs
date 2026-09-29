// [grocery] B3 · Part D — THE DELIBERATE BREAKS.
//
//   node scripts/grocery-b3/breaks.mjs
//
// Each one: hash the file, make ONE edit that violates a ruling, run the test
// file, REQUIRE a failure, restore, and prove the restore by hash.
//
// A break that does NOT turn red is the finding — it means the rule is asserted
// by nothing at all, and the test suite is agreeing with the code rather than
// checking it.
//
// Node rather than PowerShell (B1/B2 used a .ps1): the anchors here carry
// apostrophes and non-ASCII, and Windows PowerShell 5.1 reads a BOM-less UTF-8
// file as ANSI, which turns one of those into a parser error.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const S = "src/lib/";
const R = "src/routes/";

/** name, file, from, to, test, rule */
const BREAKS = [
  {
    name: "1. the split is dropped from the same-unit line",
    file: `${S}recurringItems.ts`,
    from: `    mealQuantity = comparable && recurringQuantity !== null
      ? Math.max(0, row.quantity - recurringQuantity)
      : row.quantity;`,
    to: `    mealQuantity = null;`,
    test: `${S}__tests__/recurringItems.test.ts`,
    rule: "R3: same unit -> one line, summed, WITH the split (\"5 lemons - 2 recurring + 3 for meals\")",
  },
  {
    name: "2. the gallon covers the cups",
    file: `${S}recurringItems.ts`,
    from: `  if (!isCountUnit(recurringUnit) || !isCountUnit(mealUnit)) return false;
  return canonicalUnitToken(recurringUnit) === canonicalUnitToken(mealUnit);`,
    to: `  return true;`,
    test: `${S}__tests__/groceryList.test.ts`,
    rule: "R3 (⛔): never pantry, leftover or consumption modelling. The app never decides a gallon covers two cups.",
  },
  {
    name: "3. the synthetic's pack is re-invented per run",
    file: `${S}groceryList.ts`,
    from: `      skipGapFill: true,
    };
    buckets.set(key, appended);`,
    to: `    };
    buckets.set(key, appended);`,
    test: `${S}__tests__/groceryList.test.ts`,
    rule: "D-WS9-284 ruling 2 step 3: a recurring synthetic is never gap-filled again",
  },
  {
    name: "4. Rule 3 reverts to drop-bought-unconditionally",
    file: `${S}cookingScheduler.ts`,
    from: `  return steps.filter((s) => {
    if ((s.pathKey ?? null) !== EXCLUDED_PATH_KEY) return true;
    if (!s.componentKey) return false;
    return !componentsWithScratch.has(s.componentKey);
  });`,
    to: `  return steps.filter((s) => (s.pathKey ?? null) !== EXCLUDED_PATH_KEY);`,
    test: `${R}__tests__/rule3Paths.test.ts`,
    rule: "D-WS9-277 Rule 3: if only shortcut, show shortcut. The 10 bought-only components lose the only step that makes them.",
  },
  {
    name: "5. the lapsed PATCH zeroes macros",
    file: `${S}mealMaterialize.ts`,
    from: `          : (carried ?? {});`,
    to: `          : {};`,
    test: `${R}__tests__/me-patch.test.ts`,
    rule: "BUG-320 / D-WS9-272: saved macros are never overwritten; a lapsed edit preserves them",
  },
  {
    name: "6. GATE 4 — a recurring row loses its mark",
    file: `${S}groceryList.ts`,
    from: `      for (const entry of met) {
        entry.isRecurringItem = true;`,
    to: `      for (const entry of met) {`,
    test: `${S}__tests__/groceryList.test.ts`,
    rule: "BUG-225 / Gate 4: a recurring row must SAY it is recurring",
  },
  {
    name: "7. household is derived from \"did not resolve\"",
    file: `${S}recurringItems.ts`,
    from: `      household: inferCategory(norm) === "Household",`,
    to: `      household: id === null,`,
    test: `${S}__tests__/recurringItems.test.ts`,
    rule: "D-WS9-284 ruling 5: household is inferCategory(text) === \"Household\", NEVER a lookup failure. Coffee is a food.",
  },
  {
    name: "8. recurring `eggs` lands on `egg`",
    file: `${S}recurringItems.ts`,
    from: `export const RECURRING_GRADE_MAP: Record<string, string> = {
  egg: "large eggs",
  eggs: "large eggs",
};`,
    to: `export const RECURRING_GRADE_MAP: Record<string, string> = {};`,
    test: `${S}__tests__/recurringItems.test.ts`,
    rule: "D-WS9-228 / ruling 4: a recurring staple's default names the GRADE the recipes assume",
  },
  {
    name: "9. the recurring default is read from the row before the table",
    file: `${S}recurringItems.ts`,
    from: `      purchase: fromTable ?? fromRow,`,
    to: `      purchase: fromRow ?? fromTable,`,
    test: `${S}__tests__/recurringItems.test.ts`,
    rule: "D-WS9-284 ruling 2: the purchase-defaults table is FIRST. Bananas is 1 bunch, not 1 banana.",
  },
  {
    name: "10. an AI call is made for a recurring synthetic",
    file: `${S}groceryListAI.ts`,
    from: `    if (it.skipGapFill) continue;`,
    to: ``,
    test: `${S}__tests__/groceryListAI.test.ts`,
    rule: "D-WS9-284 rulings 2 and 6: no AI call, and no model-authored catalog write, from a recurring resolution",
  },
];

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runTest(file) {
  try {
    const out = execFileSync(
      process.execPath,
      ["--env-file=.env", "--import", "tsx", "--test", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "UTC" } },
    );
    return { out, failed: false };
  } catch (e) {
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, failed: true };
  }
}

function failCount(out) {
  const m = out.match(/^\s*(?:ℹ\s*)?fail (\d+)\s*$/m);
  return m ? Number(m[1]) : -1;
}

const results = [];
for (const b of BREAKS) {
  const before = sha(b.file);
  const text = readFileSync(b.file, "utf8");
  let from = b.from;
  if (!text.includes(from)) from = b.from.replace(/\r\n/g, "\n");
  if (!text.includes(from)) from = b.from.replace(/\n/g, "\r\n");
  if (!text.includes(from)) {
    console.error(`ANCHOR NOT FOUND in ${b.file} for "${b.name}"`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(b.file, text.replace(from, b.to));
  const broken = sha(b.file);
  if (broken === before) {
    console.error(`break "${b.name}" changed nothing`);
    process.exitCode = 1;
    continue;
  }

  const { out } = runTest(b.test);
  const fails = failCount(out);
  const red = fails > 0;

  writeFileSync(b.file, text);
  const after = sha(b.file);
  const restored = after === before;

  results.push({ ...b, before, broken, after, fails, red, restored });
  console.log(
    `${red ? "RED  " : "GREEN"}  ${b.name}\n` +
      `       file    ${b.file}\n` +
      `       test    ${b.test}  -> fail ${fails}\n` +
      `       sha     ${before.slice(0, 12)} -> ${broken.slice(0, 12)} -> ${after.slice(0, 12)}  ${restored ? "RESTORED" : "!! NOT RESTORED"}\n` +
      `       rule    ${b.rule}\n`,
  );
}

const green = results.filter((r) => !r.red);
const unrestored = results.filter((r) => !r.restored);
console.log(`\n${results.length} breaks · ${results.length - green.length} red · ${green.length} GREEN · ${unrestored.length} unrestored`);
if (green.length > 0) {
  console.log("\nA BREAK THAT STAYED GREEN IS THE FINDING:");
  for (const g of green) console.log(`  - ${g.name}  (${g.rule})`);
}
if (unrestored.length > 0) process.exitCode = 1;
