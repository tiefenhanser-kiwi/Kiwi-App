// ── 🔴 BUG-334 — THE AMOUNT REF WHOSE UNIT SWALLOWED A NUMBER ───────────────
//
// The catalog's amount extractor split an authored mixed number into
// {quantity, unit} and the fraction landed in BOTH halves:
//
//     authored "1½ cups"   ref {quantity: 1.5, unit: "½ cups"}   → "1½ ½ cups"
//     authored "5½"        ref {quantity: 5.5, unit: "½"}        → "5½ ½"
//
// Measured on dev, 2026-09-30: 3,266 refs over 3,037 steps and 2,013 dishes —
// 1,521 public catalog dishes and 492 user-owned copies.
//
// TWO CLASSES, AND THEY NEED OPPOSITE ARITHMETIC. This is the half a
// single-class repair would have got wrong:
//
//   GLYPH (3,263) — the quantity is ALREADY RIGHT (1.5) and the unit merely
//     repeats the fraction. Drop the leading glyph from the unit; the quantity
//     is not touched.
//   DIGIT (3)     — "1 1/2 tablespoons" carries {quantity: 1, unit:
//     "1/2 tablespoons"}. The fraction is LOST, not duplicated. Parse it out of
//     the unit and ADD it to the quantity (1 → 1.5).
//
// ⚠️ EVERY ROW IS CHECKED AGAINST ITS AUTHORED SPAN BEFORE IT IS WRITTEN. The
// repaired quantity must equal the number a reader sees at [charStart,charEnd).
// A ref that fails that check is SKIPPED and reported rather than written on a
// guess — the whole defect is a value that disagreed with the text, and a
// repair that does not consult the text could only repeat it.
//
// ⚠️ SCOPE: PUBLIC CATALOG DISHES ONLY (`Dish.userId` null). D-WS9-230 — fixes
// are forward-only for user data, so the 492 user-owned copies are left alone
// and the RENDER GUARD (kiwi/lib/cooking/amountSegments.ts) is what makes them
// read correctly. That is also why the guard shipped first.
//
//   node --env-file=.env --import tsx scripts/grocery-f/bug334-repair.ts
//   node --env-file=.env --import tsx scripts/grocery-f/bug334-repair.ts --apply
//   … --include-user-dishes   (reports only; still refuses to write them)

import { PrismaClient } from "@prisma/client";

export const FRACTION_GLYPHS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
export const GLYPH_VALUE: Record<string, number> = {
  "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4,
  "⅐": 1 / 7, "⅑": 1 / 9, "⅒": 1 / 10,
  "⅓": 1 / 3, "⅔": 2 / 3,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6,
  "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};

/** A unit that opens with a number in any spelling — the BUG-334 shape. */
export const CORRUPT_UNIT = new RegExp(`^\\s*[0-9/${FRACTION_GLYPHS}]`);
export function unitIsCorrupt(unit: string | null | undefined): boolean {
  return CORRUPT_UNIT.test(unit ?? "");
}

const EPS = 1e-6;

export interface Ref {
  ingredientId?: string | null;
  quantity: number;
  unit: string;
  charStart: number;
  charEnd: number;
}

/** The leading number of an authored span: "1½ cups" → 1.5, "1 3/4 lbs" → 1.75. */
export function authoredLeadingNumber(span: string): number | null {
  const m = new RegExp(
    `^\\s*(\\d+(?:\\.\\d+)?)?\\s*(?:(\\d+)\\s*/\\s*(\\d+)|([${FRACTION_GLYPHS}]))?`,
  ).exec(span);
  if (!m) return null;
  const whole = m[1] !== undefined ? parseFloat(m[1]) : null;
  const frac =
    m[2] !== undefined && m[3] !== undefined
      ? parseInt(m[2], 10) / parseInt(m[3], 10)
      : m[4] !== undefined
        ? GLYPH_VALUE[m[4]]
        : null;
  if (whole === null && frac === null) return null;
  return (whole ?? 0) + (frac ?? 0);
}

export type Repair =
  | { ok: true; klass: "glyph" | "digit"; quantity: number; unit: string }
  | { ok: false; why: string };

/**
 * The repaired ref, or a refusal. `span` is the AUTHORED text the ref points at
 * and is the arbiter: a repair that does not reproduce it is refused.
 */
export function repairRef(ref: Ref, span: string): Repair {
  const u = ref.unit.trim();
  const authored = authoredLeadingNumber(span);
  if (authored === null) return { ok: false, why: `span "${span}" has no leading number` };

  const glyph = u[0];
  if (GLYPH_VALUE[glyph] !== undefined) {
    // The quantity already carries the fraction — strip it from the unit only.
    const unit = u.slice(1).trim();
    if (Math.abs(ref.quantity - authored) > EPS) {
      return { ok: false, why: `quantity ${ref.quantity} ≠ authored ${authored} ("${span}")` };
    }
    return { ok: true, klass: "glyph", quantity: ref.quantity, unit };
  }

  const m = /^(\d+)\s*\/\s*(\d+)\s*(.*)$/.exec(u);
  if (m) {
    const frac = parseInt(m[1], 10) / parseInt(m[2], 10);
    if (!(frac > 0) || frac >= 1) return { ok: false, why: `leading "${m[1]}/${m[2]}" is not a proper fraction` };
    const quantity = ref.quantity + frac;
    if (Math.abs(quantity - authored) > EPS) {
      return { ok: false, why: `repaired ${quantity} ≠ authored ${authored} ("${span}")` };
    }
    return { ok: true, klass: "digit", quantity, unit: m[3].trim() };
  }

  return { ok: false, why: `unit "${u}" opens with a number in no shape this repair knows` };
}

function assertDevHost(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: DATABASE_URL host is not the dev branch");
  console.log("host check: PASS (dev branch)");
}

async function main() {
  assertDevHost();
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();

  const steps = await prisma.recipeInstructionStep.findMany({
    where: { NOT: { amountRefs: { equals: null } }, ownerType: "dish" },
    select: { id: true, ownerId: true, stepIndex: true, stepTextTranslated: true, stepTextRaw: true, amountRefs: true },
  });
  const ownerIds = [...new Set(steps.map((s) => s.ownerId))];
  const dishes = await prisma.dish.findMany({ where: { id: { in: ownerIds } }, select: { id: true, userId: true } });
  const isPublic = new Map(dishes.map((d) => [d.id, d.userId === null]));

  interface Plan { stepId: string; ownerId: string; pub: boolean; stepIndex: number; refs: Ref[]; changed: { i: number; span: string; from: Ref; to: Repair & { ok: true } }[]; }
  const plans: Plan[] = [];
  const refused: { ownerId: string; pub: boolean; span: string; ref: Ref; why: string }[] = [];
  let refsTotal = 0, corruptTotal = 0;

  for (const s of steps) {
    const refs = (s.amountRefs as unknown as Ref[] | null) ?? [];
    if (!Array.isArray(refs)) continue;
    refsTotal += refs.length;
    const text = s.stepTextTranslated || s.stepTextRaw;
    const pub = isPublic.get(s.ownerId) === true;
    const changed: Plan["changed"] = [];
    refs.forEach((ref, i) => {
      if (!unitIsCorrupt(ref.unit)) return;
      corruptTotal++;
      const span = text.slice(ref.charStart, ref.charEnd);
      const r = repairRef(ref, span);
      if (!r.ok) { refused.push({ ownerId: s.ownerId, pub, span, ref, why: r.why }); return; }
      changed.push({ i, span, from: ref, to: r });
    });
    if (changed.length > 0) plans.push({ stepId: s.id, ownerId: s.ownerId, pub, stepIndex: s.stepIndex, refs, changed });
  }

  const pubPlans = plans.filter((p) => p.pub);
  const userPlans = plans.filter((p) => !p.pub);
  const pubRefs = pubPlans.reduce((n, p) => n + p.changed.length, 0);
  const userRefs = userPlans.reduce((n, p) => n + p.changed.length, 0);
  const digits = plans.flatMap((p) => p.changed.filter((c) => c.to.klass === "digit").map((c) => ({ p, c })));
  const glyphs = pubPlans.flatMap((p) => p.changed.filter((c) => c.to.klass === "glyph").map((c) => ({ p, c })));

  console.log(`\n${apply ? "APPLY" : "DRY RUN"} — BUG-334\n`);
  console.log(`steps scanned ................... ${steps.length}`);
  console.log(`refs scanned .................... ${refsTotal}`);
  console.log(`refs with a corrupt unit ........ ${corruptTotal}`);
  console.log(`  repairable, PUBLIC dish ....... ${pubRefs}   (${pubPlans.length} steps, ${new Set(pubPlans.map((p) => p.ownerId)).size} dishes)  ← written`);
  console.log(`  repairable, USER-OWNED copy ... ${userRefs}   (${userPlans.length} steps, ${new Set(userPlans.map((p) => p.ownerId)).size} dishes)  ← NOT written (D-WS9-230)`);
  console.log(`  REFUSED ....................... ${refused.length}`);

  console.log(`\n── every DIGIT-class ref (${digits.length}) ──`);
  for (const { p, c } of digits) {
    console.log(
      `  dish/${p.ownerId.slice(0, 8)} step ${p.stepIndex} ${p.pub ? "PUBLIC" : "user  "}\n` +
        `     span "${c.span}"\n` +
        `     {q:${c.from.quantity}, u:"${c.from.unit}"}  →  {q:${c.to.quantity}, u:"${c.to.unit}"}`,
    );
  }

  console.log(`\n── 10 GLYPH-class refs (of ${pubRefs - digits.filter((d) => d.p.pub).length} public) ──`);
  for (const { p, c } of glyphs.slice(0, 10)) {
    console.log(
      `  dish/${p.ownerId.slice(0, 8)} step ${p.stepIndex}  span "${c.span}"  ` +
        `{q:${c.from.quantity}, u:"${c.from.unit}"} → {q:${c.to.quantity}, u:"${c.to.unit}"}`,
    );
  }

  if (refused.length > 0) {
    console.log(`\n🔴 REFUSED (${refused.length}) — written on no guess:`);
    for (const r of refused.slice(0, 25)) {
      console.log(`  dish/${r.ownerId.slice(0, 8)} ${r.pub ? "PUBLIC" : "user"}  span "${r.span}"  u="${r.ref.unit}"  — ${r.why}`);
    }
    if (refused.length > 25) console.log(`  … ${refused.length - 25} more`);
  }

  if (!apply) { console.log(`\n(dry run — nothing written. Re-run with --apply)`); await prisma.$disconnect(); return; }
  if (refused.length > 0) {
    console.log(`\n🔴 REFUSING TO APPLY: the dry run is not clean (${refused.length} refused). Fix or narrow first.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  let written = 0;
  for (const p of pubPlans) {
    const next = p.refs.map((r, i) => {
      const c = p.changed.find((x) => x.i === i);
      return c ? { ...r, quantity: c.to.quantity, unit: c.to.unit } : r;
    });
    await prisma.recipeInstructionStep.update({
      where: { id: p.stepId },
      data: { amountRefs: next as unknown as object },
    });
    written++;
  }
  console.log(`\n✅ repaired ${pubRefs} refs across ${written} public-catalog steps.`);
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("bug334-repair")) main().catch((e) => { console.error(e); process.exit(1); });
