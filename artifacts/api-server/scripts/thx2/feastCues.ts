// SERVER-13 D (BUG-628) — THE FEASTS' COOK MODE CUES, BEFORE → AFTER. Read-only, no AI.
//
// A feast's Cook Mode cues are computed when Cook Mode opens (cookingSequence.ts →
// cookingScheduler.ts composeCue), from the stored steps' words: NOTHING STORED holds
// a cue, so a cue change ships with the server image, and this script has no --apply.
// It is the release step's proof instead: snapshot every feast's whole sequence with
// one build, diff it against another, and print every changed cue. Anything else that
// moves — a step, its order, its offset, a merged step, the totals — is printed and
// the run exits 1 (STOP: that is more than cue words).
//
//   node --env-file=.env --import tsx scripts/thx2/feastCues.ts --save before.json             # snapshot (this build)
//   node --env-file=.env --import tsx scripts/thx2/feastCues.ts --against before.json --out cues.txt
//   node --env-file=.env --import tsx scripts/thx2/feastCues.ts --targets prod-copy ...         # dev: production's copies (importFeastCopies.ts)
//   node --env-file=.env --import tsx scripts/thx2/feastCues.ts --all-feasts ...                # every thanksgiving-feast meal, user copies too
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0). It reads meals and steps, nothing else.

import { readFileSync, writeFileSync } from "node:fs";
import { format } from "node:util";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { runCookingSequence, type CookingSequenceResult } from "../../src/lib/cookingSequence";
import { FEAST_MEAL_TAG } from "../../src/lib/prepWeekAggregation";
import { loadTargets } from "./thx2Core";

const argv = process.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${flag}: a value`); process.exit(2); }
  return v;
};
// THX-4 — `--out <file>`: every printed line to a UTF-8 file too (PowerShell's `>` writes UTF-16).
const OUT = arg("--out");
if (OUT) {
  const printed: string[] = [];
  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => { printed.push(format(...a)); log(...a); };
  process.on("exit", () => writeFileSync(OUT, printed.join("\n") + "\n", "utf8"));
}
if (argv.includes("--apply")) { console.error("feastCues has no --apply: a cue is computed when Cook Mode opens, nothing stored holds one"); process.exit(2); }
const SAVE = arg("--save");
const AGAINST = arg("--against");
const TARGETS = arg("--targets") ?? "feasts";
if (TARGETS !== "feasts" && TARGETS !== "prod-copy") { console.error(`--targets: feasts | prod-copy (got ${TARGETS})`); process.exit(2); }
const ALL = argv.includes("--all-feasts");

const { host, mode } = assertScriptDatabase("thx2/feastCues");
if (TARGETS === "prod-copy" && mode !== "dev") { console.error("--targets prod-copy is dev only"); process.exit(2); }
console.log(`database: ${host} (${mode}) · read-only${TARGETS === "prod-copy" ? " · production's copies" : ""}${ALL ? " · every feast meal" : ""}`);

const prisma = new PrismaClient();

interface Line { dish: string; step: number; seq: number; offset: number; cue: string | null; text: string }
interface Read { meal: string; title: string; total: number; merged: string[]; lines: Line[] }

async function feastMeals(): Promise<{ key: string; id: string; title: string; userId: string | null }[]> {
  if (ALL) {
    const rows = await prisma.meal.findMany({ where: { tags: { has: FEAST_MEAL_TAG }, isArchived: false }, select: { id: true, title: true, userId: true }, orderBy: { id: "asc" } });
    return rows.map((r) => ({ key: r.id, ...r }));
  }
  const keys = loadTargets().targets.filter((t) => t.kind === "feast").map((t) => t.key);
  const out = [];
  for (const key of keys) {
    const familyKey = TARGETS === "prod-copy" ? `prodcopy:${key}` : key;
    const m = await prisma.meal.findFirst({ where: { sourceType: "batch_generated", dishFamilyKey: familyKey, isArchived: false }, select: { id: true, title: true, userId: true } });
    if (m) out.push({ key, ...m });
    else console.log(`${key}: no meal`);
  }
  return out;
}

/** prisma, with this one meal read as public (Cook Mode's access check), and nothing else changed. */
function asVisible(mealId: string): PrismaClient {
  const meal = new Proxy(prisma.meal, {
    get(t, p) {
      if (p !== "findUnique") return Reflect.get(t, p);
      return async (args: { where: { id: string } }) => {
        const row = await (t.findUnique as (a: unknown) => Promise<Record<string, unknown> | null>)(args);
        return row && args.where.id === mealId ? { ...row, isPublic: true } : row;
      };
    },
  });
  return new Proxy(prisma, { get: (t, p) => (p === "meal" ? meal : Reflect.get(t, p)) });
}

async function readAll(): Promise<Record<string, Read>> {
  const reads: Record<string, Read> = {};
  for (const m of await feastMeals()) {
    let r: CookingSequenceResult;
    try {
      // The catalog feasts are hosting-only (not isPublic) and have no owner: read as their own.
      r = await runCookingSequence({ mealId: m.id, userId: m.userId ?? "feast-cues", deps: { prisma: asVisible(m.id) } });
    } catch (err) {
      console.log(`${m.key}: ${(err as Error).message}`);
      continue;
    }
    const dishes = await prisma.dish.findMany({ where: { id: { in: [...new Set(r.sequence.map((s) => s.dishId))] } }, select: { id: true, title: true } });
    const titleOf = new Map(dishes.map((d) => [d.id, d.title]));
    const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.id) } }, select: { ownerId: true, stepIndex: true, stepTextTranslated: true } });
    const textOf = new Map(steps.map((s) => [`${s.ownerId}#${s.stepIndex}`, s.stepTextTranslated]));
    reads[m.key] = {
      meal: m.id,
      title: m.title,
      total: r.totalEstimatedMinutes,
      merged: (r.mergedSteps ?? []).map((s) => `${s.dishId}#${s.originalStepIndex}`),
      lines: r.sequence.map((s) => ({
        dish: titleOf.get(s.dishId) ?? s.dishId,
        step: s.originalStepIndex,
        seq: s.sequenceIndex,
        offset: s.startOffsetMinutes,
        cue: s.reason ?? null,
        text: (textOf.get(`${s.dishId}#${s.originalStepIndex}`) ?? "").slice(0, 70),
      })),
    };
  }
  return reads;
}

const now = await readAll();
console.log(`${Object.keys(now).length} feast sequences, ${Object.values(now).reduce((n, r) => n + r.lines.length, 0)} steps, ${Object.values(now).reduce((n, r) => n + r.lines.filter((l) => l.cue).length, 0)} cues`);
if (SAVE) {
  writeFileSync(SAVE, JSON.stringify(now, null, 1), "utf8");
  console.log(`saved ${SAVE}`);
}
let other = 0;
if (AGAINST) {
  const was = JSON.parse(readFileSync(AGAINST, "utf8")) as Record<string, Read>;
  let changed = 0;
  const tally = new Map<string, number>();
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const a = was[key];
    const b = now[key];
    if (!a || !b) { console.log(`✖ ${key}: ${a ? "gone" : "new"}`); other++; continue; }
    const head = `${b.title} (${key.slice(0, 40)})`;
    const shape = (r: Read) => JSON.stringify({ total: r.total, merged: r.merged, lines: r.lines.map(({ cue: _c, ...l }) => l) });
    if (shape(a) !== shape(b)) {
      other++;
      console.log(`✖ ${head}: MORE THAN CUES MOVED — total ${a.total} → ${b.total}, merged ${a.merged.length} → ${b.merged.length}`);
      a.lines.forEach((l, i) => {
        const m = b.lines[i];
        if (!m || m.dish !== l.dish || m.step !== l.step || m.offset !== l.offset || m.seq !== l.seq) console.log(`    #${i} ${l.dish} s${l.step} @${l.offset} → ${m ? `${m.dish} s${m.step} @${m.offset}` : "(none)"}`);
      });
      continue;
    }
    const diffs = a.lines.map((l, i) => [l, b.lines[i]] as const).filter(([l, m]) => l.cue !== m.cue);
    if (diffs.length === 0) continue;
    console.log(`\n${head}: ${diffs.length} cue${diffs.length === 1 ? "" : "s"}`);
    for (const [l, m] of diffs) {
      changed++;
      const st = (c: string | null) => /^With the .+? ((?:in the |heating |staying |the )?\w+), start on/.exec(c ?? "")?.[1] ?? (c ? "other" : "none");
      tally.set(`${st(l.cue)} → ${st(m.cue)}`, (tally.get(`${st(l.cue)} → ${st(m.cue)}`) ?? 0) + 1);
      console.log(`  #${l.seq} ${l.dish} s${l.step} @${l.offset} "${l.text}"`);
      console.log(`     - ${l.cue ?? "(no cue)"}`);
      console.log(`     + ${m.cue ?? "(no cue)"}`);
    }
  }
  console.log(`\n${changed} cue lines changed; ${other} sequence${other === 1 ? "" : "s"} moved in anything but cue words`);
  for (const [k, n] of [...tally].sort((x, y) => y[1] - x[1])) console.log(`  ${n} × ${k}`);
}
await prisma.$disconnect();
process.exitCode = other > 0 ? 1 : 0;
