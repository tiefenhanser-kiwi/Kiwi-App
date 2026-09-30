// [grocery] F Part B / D-WS9-292 exception 3 — piece weights from AUTHORED TEXT.
//
// Source 2 (a catalog pack stating a weight AND a piece count) covers pork
// chops, salmon fillets and porterhouse and stops. This is the same shape in a
// second place: recipe prose routinely states both at once. Three spellings,
// and the difference between them is the whole correctness of the number:
//
//     "4 bone-in chicken thighs (about 2 pounds)"   TOTAL   → 2 ÷ 4
//     "4 tilapia fillets (about 6 oz each)"          PER     → 6 oz, no divide
//     "4 (6-ounce) salmon fillets"                   PER     → 6 oz, no divide
//
// ⚠️ "each" IS LOAD-BEARING. The first cut of this script divided the per-piece
// spelling by the count as well and reported a tilapia fillet at 1.5 oz. A
// weight inside a parenthetical means the piece unless the sentence says the
// parenthetical is the total — so the DEFAULT for a bare "(6 oz)" following a
// count is per-piece, and only "(about 2 pounds)" with no "each" and a weight
// larger than the count reads as a total.
//
// Every hit is data a recipe author wrote, not a number this lane invented, and
// the spread across hits is what says whether a family has ONE typical weight
// or none. Read-only.
//
//   node --env-file=.env --import tsx scripts/grocery-f/piece-weights-text.ts [--dump <family>]

import { PrismaClient } from "@prisma/client";

const CUT =
  "chicken breasts?|chicken thighs?|chicken drumsticks?|chicken wings?|" +
  "pork chops?|lamb chops?|pork tenderloins?|chicken cutlets?|veal cutlets?|" +
  "salmon fill?ets?|cod fill?ets?|tilapia fill?ets?|halibut fill?ets?|" +
  "sea bass fill?ets?|snapper fill?ets?|trout fill?ets?|fish fill?ets?|" +
  "ribeye steaks?|strip steaks?|sirloin steaks?|flank steaks?|steaks?|" +
  "breasts?|thighs?|drumsticks?|chops?|fill?ets?|cutlets?|" +
  "lamb shanks?|short ribs?|duck breasts?|lobster tails?";

const N = String.raw`\d+(?:[.\/]\d+)?|\d+\s*[¼½¾⅓⅔⅛⅜⅝⅞]|[¼½¾⅓⅔⅛⅜⅝⅞]`;
const UNIT = String.raw`lbs?\.?|pounds?|oz\.?|ounces?`;

/**
 * Every (count, weight, per-piece?) triple in one string. `exec` in a loop
 * rather than one `.exec` — a step naming two cuts must yield both.
 */
const SHAPES: { re: RegExp; read: (m: RegExpExecArray) => { count: number; amt: number; unit: string; per: boolean; cut: string } | null }[] = [
  {
    // "4 bone-in chicken thighs (about 2 pounds)" | "(6 oz each)"
    re: new RegExp(
      `\\b(\\d+)\\s+(?:[a-z][a-z-]*\\s+){0,5}?(${CUT})\\b[^.;()]{0,20}?` +
        `\\(\\s*(?:about|approx\\.?|approximately|roughly|~)?\\s*(${N})\\s*(${UNIT})\\s*(each|apiece|per)?\\s*[^)]{0,18}\\)`,
      "gi",
    ),
    read: (m) => ({ count: parseInt(m[1], 10), amt: num(m[3]), unit: m[4], per: Boolean(m[5]), cut: m[2] }),
  },
  {
    // "4 (6-ounce) salmon fillets" | "two 6-oz steaks"
    re: new RegExp(
      `\\b(\\d+)\\s*\\(?\\s*(${N})\\s*-?\\s*(${UNIT})\\s*\\)?\\s*(?:[a-z][a-z-]*\\s+){0,4}?(${CUT})\\b`,
      "gi",
    ),
    read: (m) => ({ count: parseInt(m[1], 10), amt: num(m[2]), unit: m[3], per: true, cut: m[4] }),
  },
];

const GLYPH: Record<string, number> = { "¼": .25, "½": .5, "¾": .75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": .125, "⅜": .375, "⅝": .625, "⅞": .875 };
function num(s: string): number {
  const t = s.trim();
  const g = /^(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/.exec(t);
  if (g) return (g[1] ? parseInt(g[1], 10) : 0) + GLYPH[g[2]];
  if (t.includes("/")) { const [a, b] = t.split("/").map(Number); return b ? a / b : NaN; }
  return parseFloat(t);
}

const FAMILY: [RegExp, string][] = [
  [/chicken breast|duck breast|^breasts?$/i, "chicken breast"],
  [/chicken thigh|^thighs?$/i, "chicken thigh"],
  [/drumstick/i, "chicken drumstick"],
  [/chicken wing/i, "chicken wing"],
  [/cutlet/i, "cutlet"],
  [/pork chop/i, "pork chop"],
  [/lamb chop/i, "lamb chop"],
  [/^chops?$/i, "chop (unqualified)"],
  [/pork tenderloin/i, "pork tenderloin"],
  [/salmon fill?et/i, "salmon fillet"],
  [/(cod|tilapia|halibut|sea bass|snapper|trout|fish) fill?et|^fill?ets?$/i, "white-fish fillet"],
  [/lamb shank/i, "lamb shank"],
  [/short rib/i, "short rib"],
  [/lobster tail/i, "lobster tail"],
  [/steak/i, "steak"],
];
function famOf(cut: string): string | null {
  for (const [re, f] of FAMILY) if (re.test(cut)) return f;
  return null;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const prisma = new PrismaClient();

  const texts: string[] = [];
  const ings = await prisma.ingredient.findMany({ select: { displayName: true, canonicalName: true } });
  for (const g of ings) { texts.push(g.displayName); texts.push(g.canonicalName); }
  const di = await prisma.dishIngredient.findMany({ select: { preparationNote: true } });
  for (const d of di) if (d.preparationNote) texts.push(d.preparationNote);
  const steps = await prisma.recipeInstructionStep.findMany({ select: { stepTextTranslated: true, stepTextRaw: true } });
  for (const s of steps) texts.push(s.stepTextTranslated || s.stepTextRaw);
  console.log(`scanned ${ings.length} ingredients + ${di.length} dish-ingredient notes + ${steps.length} steps`);

  const hits = new Map<string, { lb: number; src: string; per: boolean }[]>();
  for (const t of texts) {
    if (!t) continue;
    for (const shape of SHAPES) {
      shape.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = shape.re.exec(t)) !== null) {
        const r = shape.read(m);
        if (!r || !(r.count > 0) || !Number.isFinite(r.amt) || !(r.amt > 0)) continue;
        const lb = /^o/i.test(r.unit) ? r.amt / 16 : r.amt;
        // A bare "(N lb)" after a count reads as the TOTAL only when it is not
        // marked per-piece AND dividing it lands in a plausible piece range.
        const per = r.per ? lb : lb / r.count;
        if (!(per >= 0.1) || per > 2.5) continue; // 1.6 oz .. 2.5 lb is a cut
        const fam = famOf(r.cut);
        if (!fam) continue;
        const l = hits.get(fam) ?? [];
        l.push({ lb: per, per: r.per, src: t.slice(Math.max(0, m.index - 6), m.index + m[0].length + 4).replace(/\s+/g, " ") });
        hits.set(fam, l);
      }
    }
  }

  const dump = process.argv.indexOf("--dump") >= 0 ? process.argv[process.argv.indexOf("--dump") + 1] : null;
  console.log(`\n── piece weights found in authored text ──`);
  for (const [fam, list] of [...hits.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const vals = list.map((x) => x.lb).sort((a, b) => a - b);
    const mode = new Map<string, number>();
    for (const v of vals) { const k = v.toFixed(3); mode.set(k, (mode.get(k) ?? 0) + 1); }
    const top = [...mode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(
      `\n  ${fam}  n=${vals.length}  min ${vals[0].toFixed(3)}  median ${vals[Math.floor(vals.length / 2)].toFixed(3)}  max ${vals[vals.length - 1].toFixed(3)} lb`,
    );
    console.log(`     commonest: ${top.map(([k, c]) => `${k} lb ×${c}`).join("  ·  ")}`);
    for (const s of list.slice(0, dump === fam ? list.length : 3)) {
      console.log(`     ${s.per ? "PER " : "TOT "} ${s.lb.toFixed(3)} …${s.src}…`);
    }
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("piece-weights-text")) main().catch((e) => { console.error(e); process.exit(1); });
