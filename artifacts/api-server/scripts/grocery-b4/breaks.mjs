// [grocery] B4 · Part C — THE DELIBERATE BREAKS.
//
//   node scripts/grocery-b4/breaks.mjs
//
// Each one: hash the file, make ONE edit that violates a ruling, run the test
// file, REQUIRE a failure, restore, and prove the restore by hash.
//
// A break that does NOT turn red is the finding — the rule is asserted by
// nothing and the suite is agreeing with the code rather than checking it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const S = "src/lib/";

const BREAKS = [
  {
    name: "1. packCount is derived from purchaseQuantity",
    file: `${S}groceryListAI.ts`,
    from: `      // THE INVARIANT a consumer uses to tell a count from a size: when the
      // server scaled, these two are the same number.
      packCount: scaled.purchaseQuantity,`,
    to: `      packCount: item.purchaseQuantity,`,
    test: `${S}__tests__/groceryListAI.test.ts`,
    rule: "D-WS9-286: packCount is the COUNT the server computed, not the per-pack size it was derived from",
  },
  {
    name: "2. N11 is keyed on hasPlanSources again",
    file: `${S}recurringItems.ts`,
    from: `  if (comparable && recurringQuantity !== null) {
    const fromPlan = row.quantity - recurringQuantity;
    if (row.hasPlanSources || fromPlan > 0) mealQuantity = Math.max(0, fromPlan);
  } else if (row.hasPlanSources) {
    mealQuantity = row.quantity;
  }`,
    to: `  if (row.hasPlanSources) {
    mealQuantity = comparable && recurringQuantity !== null
      ? Math.max(0, row.quantity - recurringQuantity)
      : row.quantity;
  }`,
    test: `${S}__tests__/recurringItems.test.ts`,
    rule: "N11: a pooled need is still a plan need — the recurring pass runs before poolComponentNeeds, which moves quantity and not sources",
  },
  {
    name: "3. the same-unit rule is dropped",
    file: `${S}groceryListAI.ts`,
    from: `  if (purchaseUnit && purchaseQuantity && purchaseQuantity > 0) {
    const nu = canonicalUnitToken(needUnit);
    if (nu.length > 0 && nu === canonicalUnitToken(purchaseUnit)) {
      return Math.max(1, Math.ceil(need / purchaseQuantity - 1e-9));
    }
  }`,
    to: ``,
    test: `${S}__tests__/groceryListAI.test.ts`,
    rule: "N12: a need of one bunch against a one-bunch pack is arithmetic, and 91 corpus rows were unrelatable for want of it",
  },
  {
    name: "4. a yield is loaded by oz / 8",
    file: "scripts/grocery-b4/proposals.ts",
    // `sour cream` is the case: a 16 oz TUB is net weight, and 16 ÷ 8 = 2 is
    // exactly the arithmetic B3·F caught on broth. The honest figure is
    // 16 oz x 28.35 / 230 g-per-cup = 1.972.
    from: `  { canonical: "sour cream",`,
    to: `  { canonical: "sour cream", unit: "cup", perPack: 2, source: "pack label \"1 container (16 oz)\" / 8" },
  { canonical: "__sour cream (shadowed)",`,
    test: `${S}__tests__/grocery-b4-proposals.test.ts`,
    rule: "B4 rule 4: a weight size needs a DENSITY. oz / 8 treats a weight ounce as a fluid ounce and over-states every pack by 4.3%.",
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
    return out;
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}
const failCount = (out) => {
  const m = out.match(/^\s*(?:ℹ\s*)?fail (\d+)\s*$/m);
  return m ? Number(m[1]) : -1;
};

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
  if (broken === before) { console.error(`break "${b.name}" changed nothing`); process.exitCode = 1; continue; }

  const out = runTest(b.test);
  const fails = failCount(out);
  const red = fails > 0;

  writeFileSync(b.file, text);
  const after = sha(b.file);
  const restored = after === before;

  results.push({ ...b, fails, red, restored });
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
