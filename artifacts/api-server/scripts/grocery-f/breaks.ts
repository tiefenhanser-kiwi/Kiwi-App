// [grocery] F Part D — the breaks.
//
// Each break edits ONE source file, runs the check that should catch it, and
// asserts RED. Then it restores the file and verifies the restore by comparing
// the file's SHA-256 against the blob **git has committed at HEAD** — not
// against a copy this script took, which would only prove it can undo its own
// edit. A break that goes green, or a restore that does not match HEAD, fails
// the run.
//
// ⚠️ IT REFUSES TO START ON A DIRTY TREE for the files it touches, because the
// SHA-256 check is against HEAD: an uncommitted edit would be silently reverted
// by a "restore".
//
//   node --env-file=.env --import tsx scripts/grocery-f/breaks.ts
//   … --only 6        run one break
//
// Break 7 does not exist: the go-ahead of September 30 added breaks (8) and (9)
// to the original six and never assigned a 7.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..", "..");
const API = join(ROOT, "artifacts", "api-server");
const KIWI = join(ROOT, "artifacts", "kiwi");

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The file's content as HEAD has it — the arbiter for every restore. */
function committed(repoRelPath: string): string {
  return execFileSync("git", ["show", `HEAD:${repoRelPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface Break {
  n: number;
  title: string;
  /** repo-relative, as git spells it */
  file: string;
  /** exact text to replace, and what with */
  from: string;
  to: string;
  /** the command that must FAIL once the break is applied */
  check: () => { ok: boolean; detail: string };
}

// ── the two test runners ───────────────────────────────────────────────────
function runNodeTest(cwd: string, args: string[], pattern?: RegExp): { ok: boolean; detail: string } {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fail = /^ℹ fail (\d+)/m.exec(out);
  const failures = fail ? parseInt(fail[1], 10) : -1;
  const matched = pattern ? pattern.test(out) : true;
  return {
    ok: failures === 0 && r.status === 0,
    detail: `exit=${r.status} fail=${failures}${pattern ? ` matched=${matched}` : ""}`,
  };
}

const serverTest = (...files: string[]) =>
  runNodeTest(API, ["--env-file=.env", "--import", "tsx", "--test", ...files]);

const kiwiTest = (...files: string[]) =>
  runNodeTest(
    KIWI,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      "./lib/api/__tests__/_setup.mjs",
      "--test",
      ...files,
    ],
  );

// ── break (9)'s check: the census gate, against a purpose-built corpus ──────
//
// The D8 gate lives in a SCRIPT, not in either test glob, so it cannot be made
// red by a test file. It is made red end-to-end instead: a one-row corpus with
// a `/soup/` row filed under meat_seafood is written to the census's own `out/`
// directory and the real checker is run over it. The fixture is the same shape
// census.ts writes, so nothing about the checker is stubbed.
const GATE_TAG = "f-gate";
function writeGateFixture(): void {
  const out = join(API, "scripts", "grocery-census", "out");
  mkdirSync(out, { recursive: true });
  const row = {
    canonicalName: "cream of chicken soup",
    displayName: "cream of chicken soup",
    quantity: 1,
    unit: "can",
    sectionKey: "meat_seafood",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    notes: null,
    isAmbiguous: false,
    wasAiInferred: false,
    purchaseUnit: "can",
    purchaseQuantity: 1,
    purchaseDisplay: "1 can (10.5 oz)",
    packCount: 1,
  };
  const file = `${GATE_TAG}__gate0000__r1.json`;
  writeFileSync(
    join(out, file),
    JSON.stringify(
      {
        planId: "gate0000-0000-0000-0000-000000000000",
        planTitle: "gate fixture",
        final: [row],
        rendered: [
          {
            packName: "1 can (10.5 oz) cream of chicken soup",
            needText: "1 can",
            line: "1 can (10.5 oz) cream of chicken soup (1 can)",
            packCount: 1,
            packSizeText: "(10.5 oz)",
          },
        ],
        consolidated: [{ canonicalName: "cream of chicken soup", sources: [{}] }],
        aiCalls: [],
        ledger: [],
      },
      null,
      1,
    ),
    "utf8",
  );
  writeFileSync(
    join(out, `_index__${GATE_TAG}.json`),
    JSON.stringify({ tag: GATE_TAG, mode: "fixture", runs: 1, spentUsd: 0, entries: [{ file, planId: "gate0000-0000-0000-0000-000000000000", mode: "fixture", run: 1 }] }, null, 1),
    "utf8",
  );
}

function gateCatchesSoup(): { ok: boolean; detail: string } {
  writeGateFixture();
  const r = spawnSync(
    process.execPath,
    ["--env-file=.env", "--import", "tsx", "scripts/grocery-census/check.ts", "--tag", GATE_TAG],
    { cwd: API, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // GREEN means "the gate caught it". The break removes the rule, so the
  // finding disappears and this returns ok:false — red, as a break must be.
  const caught = /D8 · meat_seafood → never meat_seafood/.test(out);
  return { ok: caught, detail: caught ? "D8 fired on the soup row" : "D8 SILENT on the soup row" };
}

// ── the breaks ─────────────────────────────────────────────────────────────
const BREAKS: Break[] = [
  {
    n: 1,
    title: "remove the meat rule — the breast row returns to `4 lb pack`",
    file: "artifacts/api-server/src/lib/groceryListAI.ts",
    from: `  if (protein.kind === "by_weight") {
    return freshProteinPurchase(protein.buyLb);
  }`,
    to: `  if (false && protein.kind === "by_weight") {
    return freshProteinPurchase(protein.buyLb);
  }`,
    check: () =>
      serverTest("src/lib/__tests__/groceryListAI.test.ts", "src/lib/__tests__/freshProtein.test.ts"),
  },
  {
    n: 2,
    title: "drop the exception list — bacon is bought by weight",
    file: "artifacts/api-server/src/lib/freshProtein.ts",
    from: `  const fixed = firstKeyword(FIXED_PACKAGE_MEATS, hay);
  if (fixed) return { kind: "fixed_package", keyword: fixed };`,
    to: `  const fixed = null as string | null;
  if (fixed) return { kind: "fixed_package", keyword: fixed };`,
    check: () =>
      serverTest("src/lib/__tests__/freshProtein.test.ts", "src/lib/__tests__/groceryListAI.test.ts"),
  },
  {
    n: 3,
    title: "round DOWN instead of up",
    file: "artifacts/api-server/src/lib/freshProtein.ts",
    from: `  return Math.ceil(lb / BUY_WEIGHT_STEP_LB - QTY_EPSILON) * BUY_WEIGHT_STEP_LB;`,
    to: `  return Math.floor(lb / BUY_WEIGHT_STEP_LB + QTY_EPSILON) * BUY_WEIGHT_STEP_LB;`,
    check: () => serverTest("src/lib/__tests__/freshProtein.test.ts"),
  },
  {
    n: 4,
    title: "remove the tomatillo name — the elide fires on a parenthetical again",
    file: "artifacts/kiwi/lib/format/grocery.ts",
    from: `function residueNamesItem(residue: string, name: string): boolean {
  return headNamesItem(stripParentheticals(residue), name);
}`,
    to: `function residueNamesItem(residue: string, name: string): boolean {
  return headNamesItem(residue, name);
}`,
    check: () => kiwiTest("lib/__tests__/grocery-format.test.ts"),
  },
  {
    n: 5,
    title: "remove `stalk` from the count-unit inflection",
    file: "artifacts/api-server/src/lib/ingredientConversions.ts",
    from: `  stalks: "stalk",`,
    to: ``,
    check: () => serverTest("src/lib/__tests__/prepWeekAssembly.test.ts"),
  },
  {
    n: 6,
    title: "remove BUG-334's guard — `1½ ½ cups` comes back",
    file: "artifacts/kiwi/lib/cooking/amountSegments.ts",
    from: `    if (spanHoldsRange(authored) || unitIsCorrupt(r.unit)) {`,
    to: `    if (spanHoldsRange(authored)) {`,
    check: () => kiwiTest("lib/cooking/__tests__/amountSegments.test.ts"),
  },
  {
    n: 8,
    title: "remove the count→weight conversion — the 5 count rows revert",
    file: "artifacts/api-server/src/lib/freshProtein.ts",
    from: `  if (isCountNeed(item.unit)) {`,
    to: `  if (false && isCountNeed(item.unit)) {`,
    check: () =>
      serverTest("src/lib/__tests__/freshProtein.test.ts", "src/lib/__tests__/groceryListAI.test.ts"),
  },
  {
    n: 9,
    title: "a `/soup/` row filed as meat passes the D8 gate",
    file: "artifacts/api-server/scripts/grocery-census/check.ts",
    from: `  [/\\bsoups?\\b/i, ["meat_seafood", "produce"], "a soup is a canned/pantry good"],`,
    to: ``,
    check: gateCatchesSoup,
  },
];

// ── the run ────────────────────────────────────────────────────────────────
function abs(repoRel: string): string {
  return join(ROOT, repoRel);
}

const only = process.argv.indexOf("--only") >= 0 ? Number(process.argv[process.argv.indexOf("--only") + 1]) : null;
const list = only === null ? BREAKS : BREAKS.filter((b) => b.n === only);

// Refuse a dirty tree for the files we are about to edit.
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(list.map((b) => b.file))], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
if (dirty.length > 0) {
  console.error(`🔴 REFUSING — these files differ from HEAD, so a restore would lose work:\n${dirty}`);
  process.exit(1);
}

let failures = 0;
console.log(`\n══ [grocery] F Part D — ${list.length} breaks ══\n`);
for (const b of list) {
  const path = abs(b.file);
  const head = committed(b.file);
  const before = readFileSync(path, "utf8");
  const beforeSha = sha256(before);
  if (sha256(head) !== beforeSha) {
    console.log(`(${b.n}) 🔴 SKIP — working file already differs from HEAD`);
    failures++;
    continue;
  }

  // 1. baseline: the check must be GREEN before the break.
  const baseline = b.check();
  if (!baseline.ok) {
    console.log(`(${b.n}) 🔴 BASELINE NOT GREEN — ${b.title}\n      ${baseline.detail}`);
    failures++;
    continue;
  }

  // 2. break it.
  if (!before.includes(b.from)) {
    console.log(`(${b.n}) 🔴 ANCHOR NOT FOUND in ${b.file}`);
    failures++;
    continue;
  }
  writeFileSync(path, before.replace(b.from, b.to), "utf8");
  const broken = b.check();

  // 3. restore, always — even if the check threw.
  writeFileSync(path, before, "utf8");
  const afterSha = sha256(readFileSync(path, "utf8"));
  const restored = afterSha === sha256(head);

  const red = !broken.ok;
  if (red && restored) {
    console.log(`(${b.n}) ✅ RED then RESTORED — ${b.title}`);
    console.log(`      broken: ${broken.detail}`);
    console.log(`      sha256(HEAD) == sha256(file) = ${afterSha.slice(0, 16)}…`);
  } else {
    failures++;
    console.log(`(${b.n}) 🔴 ${!red ? "STAYED GREEN" : "RESTORE MISMATCH"} — ${b.title}`);
    console.log(`      broken: ${broken.detail}  restored=${restored}`);
  }
}

console.log(`\n${failures === 0 ? "✅ all breaks red and restored" : `🔴 ${failures} break(s) did not behave`}`);
process.exit(failures === 0 ? 0 : 1);
