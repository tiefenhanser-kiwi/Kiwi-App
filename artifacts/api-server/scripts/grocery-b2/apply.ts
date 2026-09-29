// [grocery] B2 · Part B — THE APPLY HALF OF THE ROUND TRIP.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/apply.ts --dry-run
//   node --env-file=.env --import tsx scripts/grocery-b2/apply.ts --apply
//
// THE REVIEWED SHEET IS `proposals.ts`. `digest.ts` and `defaults.ts` render it
// as the numbered plain text Hans ruled on; his rulings were then written back
// into `proposals.ts` by number. So the sheet and the digests cannot drift:
// there is one source and the digests are projections of it. Same contract as
// B1's apply.ts, and the same discipline as A1's relations round trip.
//
// 🔴 EVERY WRITE HERE IS HUMAN-REVIEWED, so every relation row lands with
// `reviewedByHuman: true` / `reviewedAt` / a `rationale` carrying the ruling.
// That is not decoration: `reviewedByHuman` is the OVERWRITE GUARD, and for the
// two DEFAULTS it is the whole point — the go-ahead asked for the decision to
// live in the data and not only in the code.
//
// IDEMPOTENT. A second run must report everything unchanged. Reported per class:
// created / updated / unchanged / skipped.

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import {
  NAME_CLEANINGS,
  lowercaseLead,
  DEFAULTS,
  PACK_YIELDS,
  RELABEL_TO_SYNONYM,
  PART_EDGES,
} from "./proposals";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REVIEWED_AT = new Date("2026-09-28T22:00:00.000Z");

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");

type Stat = { created: number; updated: number; unchanged: number; skipped: number };
const stat = (): Stat => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
const stats: Record<string, Stat> = {
  "N buy names": stat(),
  "C casing": stat(),
  "D defaults (subsumes rows)": stat(),
  "Y BUG-330 pack yields": stat(),
  "R N6 relabel": stat(),
  "P fennel part edge": stat(),
};
const note = (s: string) => console.log(s);

async function main() {
  note(`[grocery] B2 Part B — ${APPLY ? "🔴 APPLY (writing)" : "DRY RUN (nothing written)"}`);
  note("");

  const ings = await prisma.ingredient.findMany({
    select: {
      id: true, canonicalName: true, displayName: true, purchaseUnit: true,
      packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
      packYieldReviewedByHuman: true,
    },
  });
  const byCanonical = new Map(ings.map((i) => [i.canonicalName, i]));
  const cleaningOf = new Map(NAME_CLEANINGS.map((c) => [c.current, c]));

  // ── N + C — the display names ────────────────────────────────────────────
  //
  // ⚠️ ONE WRITE PER ROW, NOT TWO. N and C both target `Ingredient.displayName`,
  // and N's targets are exactly the rows whose casing C would also touch. Two
  // passes would make the second one see the first one's output and report a
  // change that the sheet does not contain. The final name is computed once —
  // N's rename if there is one, otherwise C's leading-character rule — which is
  // byte-for-byte what `shadowDisplayName` did in the dry run.
  note("=== N + C — Ingredient.displayName ===");
  for (const row of ings) {
    const cleaned = cleaningOf.get(row.canonicalName);
    const klass = cleaned ? "N buy names" : "C casing";
    const target = cleaned ? cleaned.line : lowercaseLead(row.displayName);
    const s = stats[klass];
    if (target === row.displayName) { s.unchanged++; continue; }
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: { displayName: target },
      });
    }
    s.updated++;
    note(`  ${klass === "N buy names" ? "N" : "C"}  "${row.displayName}" -> "${target}"   [${row.canonicalName}]`);
  }
  // A cleaning whose canonical has no row is a sheet error, not a no-op.
  for (const c of NAME_CLEANINGS) {
    if (!byCanonical.has(c.current)) {
      stats["N buy names"].skipped++;
      note(`  SKIP N ${c.current}: no catalog row`);
    }
  }

  // ── D — the two DEFAULTS, in the data ────────────────────────────────────
  //
  // The MECHANISM is the one A2(c) proposed and the go-ahead accepted: the
  // `subsumes` row already exists and is already DIRECTED (`from` is the
  // generic, `to` is the specific), which is exactly the pin H2 needs and
  // exactly what a `synonym` row cannot carry — synonyms are stored in canonical
  // order, so their direction means nothing. No new column, no new table.
  //
  // The code constant (RULED_SUBSUMES_DEFAULTS, ingredientRelations.ts) is what
  // promotes the row past the confidence gate; this flip makes the DATA carry
  // the decision too, so a reader of the table alone can see it was ruled.
  note("");
  note("=== D — the ruled defaults, on their subsumes rows ===");
  for (const d of DEFAULTS) {
    const s = stats["D defaults (subsumes rows)"];
    if (!d.def || d.uncertain) { s.skipped++; note(`  SKIP ${d.generic}: not ruled`); continue; }
    const from = byCanonical.get(d.generic);
    const to = byCanonical.get(d.def);
    if (!from || !to) { s.skipped++; note(`  SKIP ${d.generic} -> ${d.def}: missing catalog row`); continue; }
    const rationale = `[grocery] B2 H2 DEFAULT. ${d.why}`;
    const existing = await prisma.ingredientRelation.findUnique({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      select: { id: true, label: true, reviewedByHuman: true, rationale: true, confidence: true },
    });
    if (!existing) {
      s.skipped++;
      note(`  SKIP ${d.generic} -> ${d.def}: no subsumes row (the mechanism needs one; it existed when A2 measured)`);
      continue;
    }
    if (existing.label !== "subsumes") {
      s.skipped++;
      note(`  SKIP ${d.generic} -> ${d.def}: the row is labelled ${existing.label}, not subsumes`);
      continue;
    }
    if (existing.reviewedByHuman && existing.rationale === rationale) { s.unchanged++; continue; }
    if (APPLY) {
      await prisma.ingredientRelation.update({
        where: { id: existing.id },
        data: {
          reviewedByHuman: true,
          reviewedAt: REVIEWED_AT,
          rationale,
          source: "human",
        },
      });
    }
    s.updated++;
    note(`  D  ${d.generic} ⊇ ${d.def}  reviewedByHuman ${existing.reviewedByHuman} -> true  (was ${existing.confidence})`);
  }

  // ── Y — BUG-330 ──────────────────────────────────────────────────────────
  note("");
  note("=== Y — BUG-330 pack yields ===");
  for (const y of PACK_YIELDS) {
    const s = stats["Y BUG-330 pack yields"];
    const row = byCanonical.get(normalizeIngredientName(y.ingredient));
    if (!row) { s.skipped++; note(`  SKIP ${y.ingredient}: no catalog row — ${y.why}`); continue; }
    if (!row.purchaseUnit) {
      s.skipped++;
      note(`  SKIP ${y.ingredient}: no purchaseUnit, so the ladder cannot fire (B1's rule)`);
      continue;
    }
    const same =
      row.packYieldUnit === y.unit &&
      row.packYieldPerPack === y.perPack &&
      row.packYieldSource === y.source &&
      row.packYieldReviewedByHuman === true;
    if (same) { s.unchanged++; continue; }
    const was = row.packYieldPerPack == null ? "null" : `${row.packYieldPerPack} ${row.packYieldUnit}`;
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: {
          packYieldUnit: y.unit,
          packYieldPerPack: y.perPack,
          packYieldSource: y.source,
          packYieldReviewedByHuman: true,
        },
      });
    }
    s.updated++;
    note(`  Y  ${y.ingredient}: ${was} -> ${y.perPack} ${y.unit} per ${row.purchaseUnit}`);
  }

  // ── R — N6's relabel ─────────────────────────────────────────────────────
  //
  // ⚠️ A `synonym` row must be stored in CANONICAL ORDER (from.canonicalName <
  // to.canonicalName), which is what makes one pair one row and keeps `--apply`
  // idempotent. "romaine lettuce" < "romaine lettuce hearts", so the existing
  // row is already in order and the relabel is an UPDATE. If a future relabel
  // is not, it has to delete and recreate — asserted here rather than assumed.
  note("");
  note("=== R — N6: component -> synonym ===");
  for (const r of RELABEL_TO_SYNONYM) {
    const s = stats["R N6 relabel"];
    const from = byCanonical.get(r.from);
    const to = byCanonical.get(r.to);
    if (!from || !to) { s.skipped++; note(`  SKIP ${r.from} -> ${r.to}: missing catalog row`); continue; }
    if (r.from >= r.to) {
      s.skipped++;
      note(`  SKIP ${r.from} -> ${r.to}: a synonym must be stored in canonical order and this pair is not — needs a delete+create, which this sheet does not authorise`);
      continue;
    }
    const existing = await prisma.ingredientRelation.findUnique({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      select: { id: true, label: true, reviewedByHuman: true, yieldQuantity: true },
    });
    if (!existing) { s.skipped++; note(`  SKIP ${r.from} -> ${r.to}: no row`); continue; }
    if (existing.label === "synonym" && existing.reviewedByHuman) { s.unchanged++; continue; }
    if (APPLY) {
      await prisma.ingredientRelation.update({
        where: { id: existing.id },
        data: {
          label: "synonym",
          // A synonym carries no magnitude, by schema contract. Leaving the
          // component's yield behind would be a number a later reader could use.
          yieldQuantity: null,
          yieldUnit: null,
          coHarvestable: null,
          reviewedByHuman: true,
          reviewedAt: REVIEWED_AT,
          source: "human",
          rationale: `[grocery] B2 N6. ${r.why}`,
        },
      });
    }
    s.updated++;
    note(`  R  ${r.from} -> ${r.to}: ${existing.label} -> synonym (yield ${existing.yieldQuantity ?? "null"} cleared)`);
  }

  // ── P — the fennel part edge ─────────────────────────────────────────────
  note("");
  note("=== P — the fennel part edge ===");
  for (const p of PART_EDGES) {
    const s = stats["P fennel part edge"];
    const from = byCanonical.get(p.parent);
    const to = byCanonical.get(p.child);
    if (!from || !to) { s.skipped++; note(`  SKIP ${p.parent} -> ${p.child}: missing catalog row`); continue; }
    const existing = await prisma.ingredientRelation.findUnique({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      select: {
        id: true, label: true, yieldQuantity: true, yieldUnit: true,
        coHarvestable: true, reviewedByHuman: true,
      },
    });
    const want = {
      label: "component" as const,
      yieldQuantity: p.yieldQuantity,
      yieldUnit: p.yieldUnit,
      coHarvestable: p.coHarvestable,
      confidence: "high" as const,
      source: "human" as const,
      reviewedByHuman: true,
      reviewedAt: REVIEWED_AT,
      rationale: `[grocery] B2 R7. ${p.why}`,
    };
    if (
      existing &&
      existing.label === "component" &&
      existing.yieldQuantity === p.yieldQuantity &&
      existing.yieldUnit === p.yieldUnit &&
      existing.coHarvestable === p.coHarvestable &&
      existing.reviewedByHuman
    ) { s.unchanged++; continue; }
    if (APPLY) {
      if (existing) {
        await prisma.ingredientRelation.update({ where: { id: existing.id }, data: want });
      } else {
        await prisma.ingredientRelation.create({
          data: { fromIngredientId: from.id, toIngredientId: to.id, ...want },
        });
      }
    }
    if (existing) { s.updated++; note(`  P  ${p.parent} -> ${p.child}: ${existing.label} updated`); }
    else { s.created++; note(`  P  ${p.parent} -> ${p.child}: created`); }
  }

  // ── the report ───────────────────────────────────────────────────────────
  note("");
  note("=".repeat(70));
  let tc = 0, tu = 0, tn = 0, ts = 0;
  for (const [k, s] of Object.entries(stats)) {
    note(`  ${k.padEnd(30)} created ${String(s.created).padStart(3)} · updated ${String(s.updated).padStart(3)} · unchanged ${String(s.unchanged).padStart(4)} · skipped ${String(s.skipped).padStart(2)}`);
    tc += s.created; tu += s.updated; tn += s.unchanged; ts += s.skipped;
  }
  note(`  ${"TOTAL".padEnd(30)} created ${String(tc).padStart(3)} · updated ${String(tu).padStart(3)} · unchanged ${String(tn).padStart(4)} · skipped ${String(ts).padStart(2)}`);
  note("");
  note(APPLY ? "🔴 WRITTEN." : "Nothing written. Re-run with --apply.");
}

await main();
await prisma.$disconnect();
