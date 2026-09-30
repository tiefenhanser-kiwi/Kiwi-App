// [grocery] F Part A / BUG-334 — the amountRefs whose UNIT swallowed a number.
//
// Read-only. Counts every ref across `recipe_instruction_steps.amountRefs` whose
// `unit` begins with a fraction glyph, a digit or a slash, groups them by SHAPE,
// and shows what the render produces for each.
//
//   node --env-file=.env --import tsx scripts/grocery-f/f6-measure.ts [--all]

import { PrismaClient } from "@prisma/client";

function assertDevHost() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
}

export interface Ref {
  ingredientId?: string | null;
  quantity: number;
  unit: string;
  charStart: number;
  charEnd: number;
}

/**
 * 🔴 BUG-334 — A UNIT THAT OPENS WITH A NUMBER IS NOT A UNIT.
 *
 * The catalog's amount extractor splits an authored mixed number ("1½ cups",
 * "1 3/4 lbs") into {quantity, unit} and the fraction lands in BOTH: the
 * quantity holds 1.5 and the unit holds the literal "½ cups". The renderer then
 * prints the quantity AND the unit, so the fraction appears twice.
 *
 * Detected by SHAPE rather than by a list of bad strings: no real unit token in
 * this project — not one of the 49 spellings the catalog carries — begins with a
 * digit, a vulgar fraction or a slash. The three openings are exactly the three
 * ways a number can lead: a glyph ("½ cups"), a digit ("3/4 lbs", "2 hours"),
 * or a bare slash ("/4 cups", the extractor's other split point).
 */
export const FRACTION_GLYPHS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
export const CORRUPT_UNIT = new RegExp(`^\\s*[0-9/${FRACTION_GLYPHS}]`);

export function unitIsCorrupt(unit: string | null | undefined): boolean {
  return CORRUPT_UNIT.test(unit ?? "");
}

/** The SHAPE of a corrupt unit, for grouping: the leading token class + tail. */
function shapeOf(unit: string): string {
  const u = unit.trim();
  const lead = FRACTION_GLYPHS.includes(u[0])
    ? "GLYPH"
    : u[0] === "/"
      ? "SLASH"
      : "DIGIT";
  const tail = u
    .replace(new RegExp(`^[0-9/${FRACTION_GLYPHS}]+`), "")
    .replace(/^\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?/, "·RANGE")
    .trim();
  const hasRange = new RegExp(`(?:-|–|—|\\bto\\b)`).test(u);
  return `${lead}${hasRange ? "+RANGE" : ""} → "${tail || "(nothing)"}"`;
}

async function main() {
  assertDevHost();
  const prisma = new PrismaClient();
  const rows = await prisma.recipeInstructionStep.findMany({
    where: { NOT: { amountRefs: { equals: null } } },
    select: {
      id: true,
      ownerType: true,
      ownerId: true,
      stepIndex: true,
      stepTextTranslated: true,
      stepTextRaw: true,
      amountRefs: true,
    },
  });
  let refTotal = 0;
  const corrupt: {
    stepId: string; ownerType: string; ownerId: string; stepIndex: number;
    ref: Ref; authored: string; shape: string; renders: string;
  }[] = [];
  for (const r of rows) {
    const refs = (r.amountRefs as unknown as Ref[] | null) ?? [];
    if (!Array.isArray(refs)) continue;
    refTotal += refs.length;
    const text = r.stepTextTranslated || r.stepTextRaw;
    for (const ref of refs) {
      if (!unitIsCorrupt(ref.unit)) continue;
      const authored = text.slice(ref.charStart, ref.charEnd);
      corrupt.push({
        stepId: r.id, ownerType: r.ownerType, ownerId: r.ownerId,
        stepIndex: r.stepIndex, ref, authored,
        shape: shapeOf(ref.unit),
        // what the current renderer prints: formatQuantity(q) + " " + unit
        renders: `${ref.quantity} ${ref.unit}`,
      });
    }
  }
  console.log(`\nsteps with amountRefs ....... ${rows.length}`);
  console.log(`refs total .................. ${refTotal}`);
  console.log(`refs with a CORRUPT unit .... ${corrupt.length}`);

  const byShape = new Map<string, typeof corrupt>();
  for (const c of corrupt) {
    const l = byShape.get(c.shape);
    if (l) l.push(c); else byShape.set(c.shape, [c]);
  }
  console.log(`\n── by shape (${byShape.size} shapes) ──`);
  for (const [shape, list] of [...byShape.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(4)}  ${shape}`);
  }

  // does the authored span hold a range the BUG-326 guard would catch?
  const NUM = String.raw`\d+(?:\.\d+)?`;
  const AUTHORED_RANGE = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}`);
  const rangeLooking = corrupt.filter((c) => /(?:-|–|—|\bto\b)/.test(c.authored));
  const guardCatches = rangeLooking.filter((c) => AUTHORED_RANGE.test(c.authored));
  console.log(`\n── the BUG-326 range guard, on these refs ──`);
  console.log(`  authored span LOOKS like a range .......... ${rangeLooking.length}`);
  console.log(`  …and BUG-326's detector matches it ....... ${guardCatches.length}`);
  console.log(`  …and it does NOT (a glyph between) ....... ${rangeLooking.length - guardCatches.length}`);

  const want = new Set(["b52fd852-28ec-4f41-9d15-c409e89d3f73"]);
  const hansRows = corrupt.filter(
    (c) => want.has(c.ownerId) || /5½|1 3\/4|3\/4 lbs/.test(c.authored + c.ref.unit),
  );
  console.log(`\n── 10 examples (Hans's two first) ──`);
  const examples = [...hansRows, ...corrupt.filter((c) => !hansRows.includes(c))].slice(0, 10);
  for (const c of examples) {
    console.log(
      `  ${c.ownerType}/${c.ownerId.slice(0, 8)} step ${c.stepIndex}\n` +
        `     authored "${c.authored}"  ref {q:${c.ref.quantity}, u:"${c.ref.unit}"}  renders "${c.renders}"`,
    );
  }
  if (process.argv.includes("--all")) {
    console.log(`\n── every corrupt ref ──`);
    for (const c of corrupt)
      console.log(`  ${c.ownerType}/${c.ownerId} step ${c.stepIndex} | "${c.authored}" | q=${c.ref.quantity} u="${c.ref.unit}"`);
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("f6-measure")) main().catch((e) => { console.error(e); process.exit(1); });
