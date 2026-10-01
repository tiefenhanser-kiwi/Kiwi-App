// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE — how this harness reuses the census checkers instead of
// reimplementing R1–R7 / K-R1–6 / P-R1–6.
//
// 🔴 THE DESIGN DECISION, AND WHY IT IS NOT AN IMPORT.
//
// The prompt says "import their checker functions; do not rewrite them". Both
// checkers turned out to export NOTHING: every detector lives inside a
// module-level `main()` that reads `out/<tag>__*.json` off disk and writes
// `_findings__<tag>.json` / `<tag>__check.json` back. There is no function to
// import.
//
// So the bridge does the stronger thing available: it writes a census-shaped
// corpus file under its own tag and SPAWNS THE CHECKERS' OWN FILES, unmodified,
// then reads their verdict files. Nothing about a rule is re-expressed here. If
// a detector is narrowed tomorrow, this harness inherits the narrowing for
// free — which an import of a copied predicate would not give.
//
// The cost of that choice, stated plainly: the corpus file has to be BUILT from
// what the browser and the HTTP API can see, and that is not everything the
// pipeline had in memory. Every gap is recorded in the returned `gaps[]` rather
// than papered over, and the checkers' own `denom` (their candidate count per
// rule) makes a rule with no candidates visible as 0-of-0 instead of a
// spurious pass. See README.md § What the browser cannot see.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  API_SERVER_ROOT,
  GROCERY_CENSUS_DIR,
  PREP_COOK_CENSUS_DIR,
} from "./env";
import type { GroceryItemWire } from "./api";

// ── the census row shapes, reproduced as the FILE FORMAT they are ───────────
//
// These mirror grocery-census/census.ts's RunResult and
// prep-cook-census/check.ts's PlanRecord. They are a serialisation contract,
// not logic: if a census field changes shape, this breaks loudly at the
// checker rather than quietly scoring the wrong thing.

interface CensusFinalItem {
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  sectionKey: string;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  notes: string | null;
}

interface CensusRenderedRow {
  packName: string;
  needText: string;
  line: string;
  packCount: number | null;
  packSizeText: string | null;
}

export interface GroceryFinding {
  detector: string;
  sub: string;
  rows: number[];
  lines: string[];
  detail: string;
  planId: string;
  file: string;
}

export interface GroceryCheckResult {
  tag: string;
  totals: Record<string, number>;
  subTotals: Record<string, number>;
  findings: GroceryFinding[];
  /** What the bridge could not supply, and what that costs. */
  gaps: string[];
  /**
   * Detectors whose findings are NOT defects, with the reason. Reported, never
   * suppressed: the count stays in `totals` and the findings stay in
   * `findings`, and a reader is told which rows to discount and why.
   */
  superseded: { detector: string; by: string; why: string }[];
}

// ── 1c — D7's R3 arm is superseded by B-R2 ──────────────────────────────────
//
// D7 asks whether a recurring row that ALSO carries a meal need has an
// annotated split, and it looks for the annotation in `it.notes`. That is where
// the split used to live. D-WS9-284 made the facets DERIVED AND NOT PERSISTED:
// the server now ships `recurringFacets` and the SCREEN composes the sentence
// through `recurringDetail` (app/grocery-list/[id].tsx:1527). `notes` is `null`
// on every row of every list this harness has generated, so D7's R3 arm fires
// on every recurring-with-meal-need row by construction — 15 of them across the
// Part A pass — and none of them is a defect.
//
// ⛔ THE CENSUS CHECKER IS NOT EDITED. It is another lane's file and its own
// corpus may still hold pre-D-WS9-284 lists where the arm is meaningful. The
// supersession is declared HERE, in this harness's output, where it describes
// this harness's runs.
//
// B-R2 is the live check: it composes each recurring row's sentence with the
// phone's own `recurringDetail` and asserts the screen renders it, which is the
// rule D-WS9-188 actually stated.
const SUPERSEDED: GroceryCheckResult["superseded"] = [
  {
    detector: "D7 · recurring + meal need merged with no annotated split (R3)",
    by: "B-R2",
    why:
      "reads `notes`, where the R3 split no longer lives — D-WS9-284 made the facets derived, " +
      "not persisted, and the sentence is composed client-side by recurringDetail(). `notes` is " +
      "null on every generated row, so this arm fires by construction. B-R2 checks the rendered " +
      "sentence instead.",
  },
];

export interface PrepCookFinding {
  rule: string;
  plan: string;
  where: string;
  detail: string;
}

export interface PrepCookCheckResult {
  tag: string;
  /** The checkers' own candidate counts — a rule with denom 0 scored nothing. */
  denom: Record<string, number>;
  findings: PrepCookFinding[];
  gaps: string[];
}

// ── canonical-name resolution ───────────────────────────────────────────────
//
// ⚠️ THE WIRE DOES NOT CARRY canonicalName, AND THE PERSISTED ROW HAS NO SUCH
// COLUMN. GroceryListItem stores ingredientId + displayName; the census's
// `final[].canonicalName` came from the pipeline's in-memory
// GenerateListOutputItem, which no HTTP response reproduces.
//
// D1 (R1/R5 — "one food, one row") groups by relations.groupKey(canonicalName),
// so feeding it displayName instead is not free. Measured over the test
// account's four seed lists: 233 rows carried an ingredientId, 219 had
// displayName === canonicalName exactly, 6 more matched after normalisation,
// and 8 genuinely differed — "vegetable oil" for `neutral oil`, "tomatillos"
// for `tomatillo`, "ground beef (80/20)" for `80/20 ground beef`. 3.4% is small
// and it is exactly the generic/specific class D1 exists to find, so the bridge
// resolves the real name rather than approximating it.
//
// The resolution is one read-only SELECT, run through `node -e` with
// cwd = artifacts/api-server so `@prisma/client` resolves from the package that
// owns it (the e2e folder lives under artifacts/kiwi and has no Prisma).
export function resolveCanonicalNames(ingredientIds: string[]): Map<string, string> {
  const ids = [...new Set(ingredientIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const script = `
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const ids = JSON.parse(process.env.KIWI_E2E_IDS);
const rows = await p.ingredient.findMany({ where: { id: { in: ids } }, select: { id: true, canonicalName: true } });
process.stdout.write(JSON.stringify(rows));
await p.$disconnect();
`;
  const out = execFileSync(
    process.execPath,
    ["--env-file=.env", "--input-type=module", "-e", script],
    {
      cwd: API_SERVER_ROOT,
      env: { ...process.env, KIWI_E2E_IDS: JSON.stringify(ids) },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const rows = JSON.parse(out) as { id: string; canonicalName: string }[];
  return new Map(rows.map((r) => [r.id, r.canonicalName]));
}

// ── grocery ──────────────────────────────────────────────────────────────────

/**
 * Map the raw GET /grocery-lists/:id items onto the census's `final[]`, and
 * render each one through the PHONE'S OWN format module — the same three
 * functions grocery-census/census.ts calls, with the same arguments
 * app/grocery-list/[id].tsx passes. Nothing about the line is composed here.
 */
export async function buildGroceryCorpus(input: {
  planId: string;
  planTitle: string;
  listId: string;
  items: GroceryItemWire[];
}): Promise<{
  final: CensusFinalItem[];
  rendered: CensusRenderedRow[];
  consolidated: { canonicalName: string; sources: unknown[] }[];
  gaps: string[];
}> {
  // Imported lazily: the module is TSX-free but it pulls the app's format
  // helpers, and keeping it out of module scope keeps a config load cheap.
  const fmt = await import("../../lib/format/grocery");
  const gaps: string[] = [];

  const canonById = resolveCanonicalNames(
    input.items.map((i) => i.ingredientId).filter((x): x is string => !!x),
  );

  // Deleted rows are not on the screen, so they are not in the corpus either.
  const live = input.items.filter((i) => !i.deletedAt);
  if (live.length !== input.items.length) {
    gaps.push(`${input.items.length - live.length} soft-deleted row(s) excluded (not rendered)`);
  }

  const unresolved = live.filter((i) => !i.ingredientId).length;
  if (unresolved > 0) {
    gaps.push(
      `${unresolved} row(s) have no ingredientId (user-added or unresolved recurring text); ` +
        `canonicalName falls back to displayName for those, as the pipeline itself does`,
    );
  }

  const final: CensusFinalItem[] = [];
  const rendered: CensusRenderedRow[] = [];

  for (const it of live) {
    const canonicalName =
      (it.ingredientId ? canonById.get(it.ingredientId) : undefined) ?? it.displayName;

    final.push({
      canonicalName,
      displayName: it.displayName,
      quantity: it.quantity,
      unit: it.unit,
      sectionKey: it.storeSection,
      isUniversalStaple: it.isUniversalStaple,
      isUserPantryStaple: it.isUserPantryStaple,
      isRecurringItem: it.isRecurringItem,
      purchaseUnit: it.purchaseUnit ?? null,
      purchaseQuantity: it.purchaseQuantity ?? null,
      purchaseDisplay: it.purchaseDisplay ?? null,
      notes: it.notes,
    });

    // ── THE PHONE'S RENDER ────────────────────────────────────────────────
    // renderRow() in grocery-census/census.ts is not exported, so the bridge
    // calls the same three lib/format/grocery.ts functions it calls, in the
    // same order, with the same arguments. Kept side by side with that
    // function on purpose: if one moves, the difference is one diff away.
    const quantityAmount = String(it.quantity);
    const quantityUnit = it.unit || undefined;
    const staple = it.isUniversalStaple || it.isUserPantryStaple;
    const needText = fmt.formatNeedText(
      quantityAmount,
      quantityUnit,
      quantityUnit ? `${it.quantity} ${it.unit}` : String(it.quantity),
    );
    const packName = fmt.composePackName(
      it.displayName,
      it.purchaseUnit ?? undefined,
      it.purchaseDisplay ?? undefined,
      quantityAmount,
      quantityUnit,
      staple,
    );
    const rp = fmt.renderedPack(
      it.purchaseDisplay ?? undefined,
      quantityAmount,
      quantityUnit,
      it.purchaseUnit ?? undefined,
      staple,
    );
    const need = needText.trim();
    rendered.push({
      packName,
      needText: need,
      line: need ? `${packName} (${need})` : packName,
      packCount: rp?.packCount ?? null,
      packSizeText: rp?.packSizeText ?? null,
    });
  }

  // ── `consolidated` — the PRE-AI rows, which D7's R3 arm reads ────────────
  //
  // ⚠️ THE CHECKER CRASHES WITHOUT IT, so this is not optional: check.ts:405
  // does `(r.consolidated as …).some(…)` to ask whether a recurring row ALSO
  // carries a meal need, and an absent field is a TypeError, not a skipped arm.
  //
  // The pipeline's pre-AI bucket list is not on any wire. What IS on the wire
  // is the server's own answer to the only question D7 asks of it:
  // `recurringFacets.mealQuantity` — non-null exactly when this plan's recipes
  // contributed to the row (groceryList.ts's R3 branch keys on the same value).
  // `mealNames` is its display-level echo. So `sources` is synthesised to the
  // right LENGTH-TRUTH (empty vs non-empty) from those two, which is all the
  // `.some(… sources.length > 0)` test reads. No per-source detail is invented.
  const consolidated = live.map((it) => {
    const facets = (it as unknown as { recurringFacets?: { mealQuantity: number | null } })
      .recurringFacets;
    const mealNeed = facets ? facets.mealQuantity !== null && facets.mealQuantity > 0 : false;
    const names = it.mealNames ?? [];
    const sources = names.length > 0 ? names.map((n) => ({ mealTitle: n })) : mealNeed ? [{}] : [];
    return {
      canonicalName:
        (it.ingredientId ? canonById.get(it.ingredientId) : undefined) ?? it.displayName,
      sources,
    };
  });
  gaps.push(
    "`consolidated` is synthesised: the pre-AI bucket list is not on any wire, so each row's " +
      "`sources` is reconstructed to the right empty/non-empty truth from recurringFacets." +
      "mealQuantity and mealNames — the only property D7's `.some(sources.length > 0)` reads",
  );

  // The census's own `final[]` is PRE-persistence; this one is POST. The two
  // differ wherever the route's transaction reshapes a row, and the only such
  // field the checkers read is `notes` (R3's annotated split). Flagged, not
  // assumed away.
  gaps.push(
    "corpus is built POST-persistence (the route's GET), where the census stops " +
      "PRE-persistence — `notes` and the *Override columns are the only fields " +
      "that can differ, and D7's R3 arm reads notes",
  );

  return { final, rendered, consolidated, gaps };
}

/** Write the corpus file(s) the grocery checker reads, then run IT. */
export function runGroceryChecker(
  tag: string,
  corpora: {
    planId: string;
    planTitle: string;
    final: CensusFinalItem[];
    rendered: CensusRenderedRow[];
    consolidated: { canonicalName: string; sources: unknown[] }[];
  }[],
  gaps: string[],
): GroceryCheckResult {
  const out = join(GROCERY_CENSUS_DIR, "out");
  const written: string[] = [];
  for (const c of corpora) {
    const file = join(out, `${tag}__${c.planId.slice(0, 8)}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          planId: c.planId,
          planTitle: c.planTitle,
          mode: "qa-browser",
          run: 1,
          consolidatedCount: c.consolidated.length,
          finalCount: c.final.length,
          consolidated: c.consolidated,
          aiSubsetKeys: [],
          final: c.final,
          rendered: c.rendered,
          interceptedWrites: [],
          aiCalls: [],
          ledger: [],
          costUsd: 0,
        },
        null,
        1,
      ),
    );
    written.push(file);
  }

  // ⚠️ THIS WRITES INTO ANOTHER LANE'S out/ DIRECTORY. It is gitignored and the
  // checkers select strictly by `startsWith("<tag>__")`, so a `qa-…` tag cannot
  // be picked up by a `live` run and vice versa. The files are removed again
  // below so a concurrent grocery-census pass never inherits them.
  let raw: string;
  try {
    execFileSync(
      process.execPath,
      ["--env-file=.env", "--import", "tsx", "scripts/grocery-census/check.ts", "--tag", tag],
      { cwd: API_SERVER_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: "pipe" },
    );
    raw = readFileSync(join(out, `_findings__${tag}.json`), "utf8");
  } finally {
    for (const f of written) rmSync(f, { force: true });
  }
  const parsed = JSON.parse(raw) as {
    totals: Record<string, number>;
    subTotals: Record<string, number>;
    findings: GroceryFinding[];
  };
  return {
    tag,
    totals: parsed.totals,
    subTotals: parsed.subTotals,
    findings: parsed.findings,
    gaps,
    superseded: SUPERSEDED,
  };
}

// ── prep & cook ──────────────────────────────────────────────────────────────

/** Write the PlanRecord the prep-cook checker reads, then run IT. */
export function runPrepCookChecker(
  tag: string,
  planRecords: unknown[],
  gaps: string[],
): PrepCookCheckResult {
  const out = join(PREP_COOK_CENSUS_DIR, "out");
  const written: string[] = [];
  for (const rec of planRecords) {
    const planId = String((rec as { planId: string }).planId);
    const file = join(out, `${tag}__${planId.slice(0, 8)}.json`);
    writeFileSync(file, JSON.stringify(rec, null, 1));
    written.push(file);
  }
  let raw: string;
  try {
    // No --env-file: the prep-cook checker touches no database at all.
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/prep-cook-census/check.ts", "--tag", tag],
      { cwd: API_SERVER_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: "pipe" },
    );
    raw = readFileSync(join(out, `${tag}__check.json`), "utf8");
  } finally {
    for (const f of written) rmSync(f, { force: true });
  }
  const parsed = JSON.parse(raw) as {
    denom: Record<string, number>;
    findings: PrepCookFinding[];
  };
  return { tag, denom: parsed.denom, findings: parsed.findings, gaps };
}

export function censusHarnessesPresent(): { ok: boolean; note: string } {
  const g = join(GROCERY_CENSUS_DIR, "check.ts");
  const p = join(PREP_COOK_CENSUS_DIR, "check.ts");
  if (!existsSync(g)) return { ok: false, note: `missing ${g}` };
  if (!existsSync(p)) return { ok: false, note: `missing ${p}` };
  return { ok: true, note: "both census checkers found" };
}
