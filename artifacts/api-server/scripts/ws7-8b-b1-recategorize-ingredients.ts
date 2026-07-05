// WS7-8b Block 1 — Ingredient re-categorize backfill.
//
// WHY: the create-time categorizer (inferCategory in ingredientResolve.ts) only
// runs when a NEW Ingredient row is created. Ingredient is a shared catalog
// (canonicalName @unique, find-or-create, write-once `update: {}`), so rows
// minted before a rule fix are REUSED forever with their stale category — the
// fixed rule never re-runs on them. This script re-infers the category for the
// existing catalog so a rule change can be swept over historical rows.
//
// SAFETY: reuses the EXACT production inferCategory (imported, not
// reimplemented) so the backfill cannot drift from the create-time categorizer.
// It feeds inferCategory the SAME field the create path feeds it: canonicalName.
// Justification — resolveIngredients() computes `canonical = name.toLowerCase()
// .trim()`, stores it as `canonicalName`, and writes `category:
// inferCategory(d.canonical)` (ingredientResolve.ts). So the stored category IS
// inferCategory(canonicalName); re-inferring from any other field (e.g.
// displayName, which keeps original casing/prefixes) could write a DIFFERENT
// category than the create path would. canonicalName is the only faithful input.
//
// DRY-RUN by default (writes nothing). Pass --apply to persist, wrapped in a
// single transaction, updating ONLY changed rows. Idempotent: a second --apply
// run reports zero changes.
//
// MODES:
//   (default) FULL-SWEEP  — re-infer EVERY catalog row; the changeset is every
//     row where inferCategory(canonicalName) !== stored category. This is the
//     BUG-017 mode: the rule table was corrected FIRST (fish sauce→Pantry,
//     peanut butter→Pantry, corn tortilla→Bakery, berry -ies plurals, edamame/
//     dough/sprout/san-marzano coverage), so a blind full re-infer is now SAFE
//     and is the intended go-forward path (the USDA fallback block will mint
//     many new rows through this same create path).
//   --spices-only         — BUG-012 back-compat scope: restrict the changeset
//     to rows whose canonicalName contains powder/granulated/dried (the #2
//     dry-form rule's domain). Preserved so the original scoped apply still
//     works; the full sweep now supersedes it for general use.
//
// Run (PowerShell, from artifacts/api-server):
//   FULL-SWEEP DRY-RUN:  node --env-file=.env --import tsx scripts/ws7-8b-b1-recategorize-ingredients.ts
//   FULL-SWEEP APPLY:    node --env-file=.env --import tsx scripts/ws7-8b-b1-recategorize-ingredients.ts --apply
//   SCOPED DRY-RUN:      node --env-file=.env --import tsx scripts/ws7-8b-b1-recategorize-ingredients.ts --spices-only
//   SCOPED APPLY:        node --env-file=.env --import tsx scripts/ws7-8b-b1-recategorize-ingredients.ts --spices-only --apply

import { PrismaClient } from "@prisma/client";

import { inferCategory } from "../src/lib/ingredientResolve";

const prisma = new PrismaClient();

interface Change {
  id: string;
  canonicalName: string;
  displayName: string;
  oldCategory: string;
  newCategory: string;
}

// BUG-012 --spices-only domain — the dry-form keywords the create-time Pantry
// rule keys on. Substring match, matching how the create rule fires.
const SPICE_SCOPE_KEYWORDS = ["powder", "granulated", "dried"];

function inSpiceScope(canonicalName: string): boolean {
  const n = canonicalName.toLowerCase();
  return SPICE_SCOPE_KEYWORDS.some((k) => n.includes(k));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const spicesOnly = process.argv.includes("--spices-only");

  const scope = spicesOnly ? "spices-only" : "full-sweep";
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== WS7-8b B1 re-categorize (${mode}, ${scope}) ===\n`);

  const rows = await prisma.ingredient.findMany({
    select: { id: true, canonicalName: true, displayName: true, category: true },
    orderBy: { canonicalName: "asc" },
  });

  const scoped = spicesOnly ? rows.filter((r) => inSpiceScope(r.canonicalName)) : rows;

  const changes: Change[] = [];
  for (const r of scoped) {
    // SAME input the create path uses (canonicalName). See file header.
    const newCategory = inferCategory(r.canonicalName);
    if (newCategory !== r.category) {
      changes.push({
        id: r.id,
        canonicalName: r.canonicalName,
        displayName: r.displayName,
        oldCategory: r.category,
        newCategory,
      });
    }
  }

  // Per-row diff.
  if (changes.length === 0) {
    console.log("(no rows would change — catalog already matches the categorizer)");
  } else {
    console.log(`Rows that WOULD change (${changes.length}):\n`);
    for (const c of changes) {
      console.log(
        `  ${c.canonicalName}  ·  ${c.oldCategory} → ${c.newCategory}`,
      );
    }
  }

  // Breakdown by old→new pair.
  const pairs = new Map<string, number>();
  for (const c of changes) {
    const key = `${c.oldCategory} → ${c.newCategory}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  console.log(`\n--- Summary ---`);
  console.log(`  catalog rows total:  ${rows.length}`);
  console.log(`  rows in scope (${scope}):  ${scoped.length}`);
  console.log(`  rows that would change: ${changes.length}`);
  if (pairs.size > 0) {
    console.log(`  by old → new:`);
    for (const [pair, n] of [...pairs.entries()].sort()) {
      console.log(`    ${pair}:  ${n}`);
    }
  }

  if (!apply) {
    console.log(`\nDRY-RUN only — nothing written. Re-run with --apply to persist.\n`);
    return;
  }

  if (changes.length === 0) {
    console.log(`\nNothing to apply. (idempotent)\n`);
    return;
  }

  // Apply: only the changed rows, in one transaction.
  await prisma.$transaction(
    changes.map((c) =>
      prisma.ingredient.update({
        where: { id: c.id },
        data: { category: c.newCategory },
      }),
    ),
  );

  console.log(`\nAPPLIED ${changes.length} update(s):`);
  for (const c of changes) {
    console.log(`  ${c.canonicalName}: ${c.oldCategory} → ${c.newCategory}`);
  }

  // Re-scan to confirm idempotency. Scope the drift check to the SAME set we
  // applied.
  const after = await prisma.ingredient.findMany({
    select: { canonicalName: true, category: true },
  });
  const afterScoped = spicesOnly
    ? after.filter((r) => inSpiceScope(r.canonicalName))
    : after;
  const stillDrifting = afterScoped.filter(
    (r) => inferCategory(r.canonicalName) !== r.category,
  ).length;
  console.log(`\n--- Final ---`);
  console.log(`  catalog rows total: ${after.length}`);
  console.log(`  rows still drifting in scope (${scope}): ${stillDrifting} (expect 0)\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
