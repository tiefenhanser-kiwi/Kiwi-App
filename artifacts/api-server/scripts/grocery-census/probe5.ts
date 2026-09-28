// A6.5 — BUG-326, measured honestly. READ-ONLY.
//
// ⚠️ The first pass of this measurement used /[\d.]+/ on the span, which reads
// "1½ cups" as 1 and calls it a mismatch against ref 1.5. That instrument
// manufactured thousands of phantom defects. This one parses the unicode
// vulgar fractions the corpus actually uses.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VULGAR: Record<string, number> = {
  "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6,
};

/** Leading amount of a span: "1½ cups" → 1.5, "1/2 tsp" → 0.5, "2-3" → 2. */
function leadingAmount(span: string): number | null {
  const s = span.trim();
  // whole + vulgar ("1½")
  const wv = new RegExp(`^(\\d+)\\s*([${Object.keys(VULGAR).join("")}])`).exec(s);
  if (wv) return parseInt(wv[1], 10) + VULGAR[wv[2]];
  // bare vulgar ("½")
  const v = new RegExp(`^([${Object.keys(VULGAR).join("")}])`).exec(s);
  if (v) return VULGAR[v[1]];
  // ascii fraction ("1/2", "1 1/2")
  const af = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)/.exec(s);
  if (af) return (af[1] ? parseInt(af[1], 10) : 0) + parseInt(af[2], 10) / parseInt(af[3], 10);
  const d = /^(\d+(?:\.\d+)?)/.exec(s);
  return d ? parseFloat(d[1]) : null;
}

async function main() {
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
    throw new Error("REFUSING: not the dev branch");
  }
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { amountRefs: { not: null } },
    select: { id: true, ownerType: true, stepTextRaw: true, amountRefs: true },
  });

  let spans = 0, outOfRange = 0, noNumber = 0, mismatch = 0, ok = 0, overlap = 0;
  const examples: string[] = [];
  const mmExamples: string[] = [];
  let stepsWithAny = 0;
  const badSteps = new Set<string>();

  for (const s of steps) {
    const refs = s.amountRefs as unknown;
    if (!Array.isArray(refs) || refs.length === 0) continue;
    stepsWithAny++;
    let cursor = -1;
    for (const r of refs as { charStart: number; charEnd: number; quantity: number; unit: string }[]) {
      spans++;
      if (
        !Number.isInteger(r.charStart) || !Number.isInteger(r.charEnd) ||
        r.charStart < 0 || r.charEnd > s.stepTextRaw.length || r.charStart >= r.charEnd
      ) {
        outOfRange++; badSteps.add(s.id);
        if (examples.length < 8) examples.push(`OUT-OF-RANGE ${r.charStart}-${r.charEnd} len=${s.stepTextRaw.length}`);
        continue;
      }
      if (r.charStart < cursor) overlap++;
      cursor = r.charEnd;
      const span = s.stepTextRaw.slice(r.charStart, r.charEnd);
      const n = leadingAmount(span);
      if (n === null) {
        noNumber++; badSteps.add(s.id);
        if (examples.length < 12) {
          examples.push(`NO NUMBER IN SPAN: "${span}" (ref ${r.quantity} ${r.unit}) — ${s.stepTextRaw.slice(0, 70)}`);
        }
        continue;
      }
      if (Math.abs(n - r.quantity) > 0.011) {
        mismatch++; badSteps.add(s.id);
        if (mmExamples.length < 15) {
          mmExamples.push(`span="${span}" parses ${n} but ref says ${r.quantity} ${r.unit} — ${s.stepTextRaw.slice(0, 70)}`);
        }
      } else ok++;
    }
  }

  console.log("=== BUG-326 — amountRefs span integrity (whole corpus) ===");
  console.log(`steps carrying amountRefs : ${stepsWithAny}`);
  console.log(`spans total               : ${spans}`);
  console.log(`  out of range / inverted : ${outOfRange}`);
  console.log(`  span contains NO number : ${noNumber}   ← the guard's target`);
  console.log(`  number present, value   : ok=${ok}  mismatched=${mismatch}`);
  console.log(`  overlapping spans       : ${overlap}`);
  console.log(`steps with ≥1 bad span    : ${badSteps.size}`);
  for (const e of examples) console.log("   ", e);
  console.log("  — value mismatches —");
  for (const e of mmExamples) console.log("   ", e);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
