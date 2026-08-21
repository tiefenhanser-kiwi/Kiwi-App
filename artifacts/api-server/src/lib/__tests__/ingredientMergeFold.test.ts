// WS9 BUG-096 (D-WS9-174) — THE DURABILITY GUARD.
//
// This is the single test that proves Ruling 2 actually holds. Everything else
// in this block is supporting.
//
// THE FAILURE IT PREVENTS: `pnpm prisma:seed` upserts by canonicalName and, as
// written before this block, hard-overwrote `Ingredient.aliases`. Phase 0
// measured the damage: 5 seed-hardcoded canonicalNames are merge-group members
// (3 of them LOSERS), 15 more loser/survivor names appear in the seed's RECIPES
// list and 9 in devData, and the seed's alias declarations claimed 4 strings
// that become survivor canonical names after the merge. Run the seed after the
// merge and it re-created three merged-away rows and then hard-failed P2002 on
// the alias unique index. The merge would have been undone by a routine reseed.
//
// WHY STATIC AND NOT A LIVE `merge -> prisma:seed -> assert` ROUND-TRIP: a live
// round-trip proves the database was clean at one moment. This proves the
// SOURCE FILES can never re-introduce the failure — it goes red the day someone
// adds `{ name: "Limes", ... }` back to a seed recipe, months from now, with no
// database involved. The live round-trip still runs as a post-apply smoke
// (scripts/ws9-bug096-durability-smoke.ts); this is the regression fence.
//
// FIXTURE STRENGTH (§27.4): the seed files are read from disk and parsed, so
// the assertions are against what `prisma:seed` will actually execute. Nothing
// here derives its expected value from the same constant the code under test
// uses — FOLD comes from ingredientMergeFold.ts, the names come from the seed
// sources, and they are independent inputs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FOLD, selectLiveGroups } from "../ingredientMergeFold";
import { normalizeAliasKey } from "../ingredientLookup";

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Strip `//` and block comments before scanning.
 *
 * WHY: the first version of this guard matched `update: { aliases:` inside a
 * COMMENT explaining the very change it was checking for, and reported the fix
 * as missing. A comment is not a call site (§27.3) — a detector that cannot
 * tell them apart produces false reds today and would produce false greens the
 * day the real code moved into a string.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SEED = stripComments(readFileSync(join(API_ROOT, "prisma", "seed.ts"), "utf8"));
const DEV_DATA = stripComments(readFileSync(join(API_ROOT, "prisma", "seeds", "devData.ts"), "utf8"));

const LOSERS = new Set(FOLD.map(([, loser]) => loser));
const SURVIVORS = new Set(FOLD.map(([survivor]) => survivor));

/** Every `name: "..."` string literal in a seed source, canonicalized the way
 *  the seed's own `canonicalize()` / `resolveIngredients` do. */
function seedIngredientNames(src: string): string[] {
  return (src.match(/name:\s*"([^"]+)"/g) ?? []).map((m) =>
    m.replace(/name:\s*"/, "").replace(/"$/, "").trim().toLowerCase(),
  );
}
function seedCanonicalNames(src: string): string[] {
  return (src.match(/canonicalName:\s*"([^"]+)"/g) ?? []).map((m) =>
    m.replace(/canonicalName:\s*"/, "").replace(/"$/, "").trim().toLowerCase(),
  );
}
/** The HOUSEHOLD_BASIC alias arrays, as (canonicalName, alias) pairs. */
function seedAliasPairs(src: string): Array<[canonical: string, alias: string]> {
  const out: Array<[string, string]> = [];
  for (const line of src.split("\n")) {
    const c = /canonicalName:\s*"([^"]+)"/.exec(line);
    const a = /aliases:\s*\[([^\]]*)\]/.exec(line);
    if (!c || !a) continue;
    for (const q of a[1].match(/"([^"]+)"/g) ?? []) {
      out.push([c[1].trim().toLowerCase(), q.slice(1, -1).trim().toLowerCase()]);
    }
  }
  return out;
}

describe("BUG-096 fold list — shape", () => {
  it("is 81 pairs and every name is distinct across the whole list", () => {
    assert.equal(FOLD.length, 81);
    const all = FOLD.flat();
    assert.equal(new Set(all).size, all.length, "a name appears in two groups");
  });

  it("survivor and loser are never the same row", () => {
    for (const [s, l] of FOLD) assert.notEqual(s, l, `degenerate pair: ${s}`);
  });

  it("every pair really is a singular/plural of one another", () => {
    // Guards against the list quietly growing into the general normalizer that
    // Phase 0 refuted. Each pair must differ ONLY by a recognised plural suffix.
    const folds: Array<(n: string) => string> = [
      (n) => (n.endsWith("ies") ? n.slice(0, -3) + "y" : n),
      (n) => (n.endsWith("ves") ? n.slice(0, -3) + "f" : n),
      (n) => (n.endsWith("ves") ? n.slice(0, -3) + "fe" : n),
      (n) => (n.endsWith("es") ? n.slice(0, -2) : n),
      (n) => (n.endsWith("s") ? n.slice(0, -1) : n),
    ];
    for (const [s, l] of FOLD) {
      const [shorter, longer] = s.length <= l.length ? [s, l] : [l, s];
      assert.ok(
        folds.some((f) => f(longer) === shorter),
        `"${s}" / "${l}" is not a plural pair — this list is NOT a general normalizer`,
      );
    }
  });
});

describe("BUG-096 SEED DURABILITY — a reseed must not undo the merge", () => {
  it("no seed.ts HOUSEHOLD_BASIC canonicalName is a merged-away LOSER", () => {
    const offenders = seedCanonicalNames(SEED).filter((n) => LOSERS.has(n));
    assert.deepEqual(
      offenders,
      [],
      `prisma:seed would RE-CREATE these merged-away rows: ${offenders.join(", ")}`,
    );
  });

  it("no seed.ts RECIPES ingredient name is a merged-away LOSER", () => {
    const offenders = [...new Set(seedIngredientNames(SEED))].filter((n) => LOSERS.has(n));
    assert.deepEqual(
      offenders,
      [],
      `prisma:seed would RE-CREATE these merged-away rows: ${offenders.join(", ")}`,
    );
  });

  it("no devData.ts ingredient or recurring-item name is a merged-away LOSER", () => {
    const names = [
      ...seedIngredientNames(DEV_DATA),
      ...(DEV_DATA.match(/recurringGroceryItems:\s*\[([^\]]*)\]/g) ?? []).flatMap((m) =>
        (m.match(/"([^"]+)"/g) ?? []).map((q) => q.slice(1, -1).trim().toLowerCase()),
      ),
    ];
    const offenders = [...new Set(names)].filter((n) => LOSERS.has(n));
    assert.deepEqual(
      offenders,
      [],
      `prisma:seed:dev would RE-CREATE / re-reference these merged-away rows: ${offenders.join(", ")}`,
    );
  });

  it("no seed alias collides with an alias the merge writes (would be P2002)", () => {
    // The merge writes aliasKey = normalizeAliasKey(loserName) -> survivor. If a
    // seed row also claims that key for a DIFFERENT ingredient, the unique index
    // takes the whole seed down.
    const mergeKeys = new Map(FOLD.map(([survivor, loser]) => [normalizeAliasKey(loser), survivor]));
    const clashes: string[] = [];
    for (const [canonical, alias] of seedAliasPairs(SEED)) {
      const owner = mergeKeys.get(normalizeAliasKey(alias));
      if (owner !== undefined && owner !== canonical) {
        clashes.push(`seed gives alias "${alias}" to "${canonical}", but the merge gives it to "${owner}"`);
      }
    }
    assert.deepEqual(clashes, [], clashes.join(" | "));
  });

  it("no seed row declares an alias equal to its own canonicalName", () => {
    // A self-alias is dead weight and, post-merge, a sign the canonical was
    // corrected without cleaning its alias list.
    const selfies = seedAliasPairs(SEED)
      .filter(([canonical, alias]) => normalizeAliasKey(alias) === normalizeAliasKey(canonical))
      .map(([c]) => c);
    assert.deepEqual(selfies, [], `self-alias on: ${selfies.join(", ")}`);
  });

  it("seed.ts no longer hard-overwrites Ingredient.aliases", () => {
    // The overwrite is what made a reseed destroy merge-written aliases. The
    // seed must write alias ROWS (a union), never the array.
    assert.ok(
      !/update:\s*\{[^}]*\baliases:/s.test(SEED),
      "prisma/seed.ts still writes `aliases` in an update — that clobbers merge-written aliases",
    );
    assert.ok(
      SEED.includes("ingredientAlias.upsert"),
      "prisma/seed.ts must upsert IngredientAlias rows (the union write)",
    );
  });

  it("the seed's own alias set has no internal duplicate (would also be P2002)", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [canonical, alias] of seedAliasPairs(SEED)) {
      const key = normalizeAliasKey(alias);
      const prev = seen.get(key);
      if (prev !== undefined && prev !== canonical) dupes.push(`"${alias}" claimed by both ${prev} and ${canonical}`);
      seen.set(key, canonical);
    }
    assert.deepEqual(dupes, [], dupes.join(" | "));
  });
});

describe("BUG-096 fold list — scope fence", () => {
  it("survivors and losers are disjoint sets", () => {
    for (const n of SURVIVORS) {
      assert.ok(!LOSERS.has(n), `"${n}" is both a survivor and a loser — the fold is not a forest`);
    }
  });

  it("the plural wins in 59 of 81 groups, matching the ratified ladder", () => {
    // Pins the ladder's OUTCOME, not its inputs. If someone re-derives the list
    // from live counts and the direction of a group flips, this goes red before
    // the merge silently reverses a fold.
    const pluralWins = FOLD.filter(([s, l]) => s.length > l.length).length;
    assert.equal(pluralWins, 59);
  });
});

describe("BUG-096 IDEMPOTENCE — a second apply must be a no-op", () => {
  const FOLD_2 = [
    ["roma tomatoes", "roma tomato"],
    ["garlic cloves", "garlic clove"],
  ] as const;

  it("first run: both rows present -> the group is LIVE work", () => {
    const sel = selectLiveGroups(
      new Set(["roma tomatoes", "roma tomato", "garlic cloves", "garlic clove"]),
      FOLD_2,
    );
    assert.equal(sel.live.length, 2);
    assert.equal(sel.merged.length, 0);
  });

  it("second run: the loser is gone -> MERGED, zero live work", () => {
    // This is the whole idempotence claim. If `live` were non-empty here the
    // second --apply would re-run every carrier rewrite against a survivor that
    // already owns the references.
    const sel = selectLiveGroups(new Set(["roma tomatoes", "garlic cloves"]), FOLD_2);
    assert.equal(sel.live.length, 0, "a second run must find NO live work");
    assert.equal(sel.merged.length, 2);
  });

  it("a partially-applied run resumes: only the un-merged group is live", () => {
    const sel = selectLiveGroups(
      new Set(["roma tomatoes", "garlic cloves", "garlic clove"]),
      FOLD_2,
    );
    assert.deepEqual(sel.live, [["garlic cloves", "garlic clove"]]);
    assert.deepEqual(sel.merged, [["roma tomatoes", "roma tomato"]]);
  });

  it("REFUSES when the loser is present but the survivor is NOT", () => {
    // Merging into an absent survivor would rewrite every carrier to a dangling
    // id — worse than not running. This must be loud, never a silent skip.
    const sel = selectLiveGroups(new Set(["roma tomato", "garlic cloves", "garlic clove"]), FOLD_2);
    assert.deepEqual(sel.refuse, [["roma tomatoes", "roma tomato"]]);
    assert.equal(sel.live.length, 1, "the healthy group is still classified live");
  });

  it("both rows absent is benign (a catalog that never had them)", () => {
    const sel = selectLiveGroups(new Set([]), FOLD_2);
    assert.equal(sel.absent.length, 2);
    assert.equal(sel.refuse.length, 0);
  });

  it("every pair lands in exactly one bucket", () => {
    const sel = selectLiveGroups(new Set(["roma tomatoes", "garlic clove"]), FOLD_2);
    assert.equal(sel.live.length + sel.merged.length + sel.absent.length + sel.refuse.length, FOLD_2.length);
  });
});
