// CAT-QUICK-1 — run batches end to end, stopping at the first one that fails a bar (Hans, Oct 30):
//   1. first pass (generate.ts, dry) · the 7-of-10 rule: ≥70% of the first pass stamps ≤30;
//   2. one rework of every concept that is not accepted (over 30, hidden cooked work, uncut knife work);
//   3. the batch = every accepted record (a later label wins per concept);
//   4. K1–K7 (kflags.ts, offline) on the batch: findings per meal ≤ the catalog's, measured now;
//   5. write.ts --apply (archives the km30 meal a concept replaces once its rebuild stamps ≤30).
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/run.ts --batches 1,2,3,4,5
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { simulate } from "../qa-cook/simulator";
import { accepted, BUDGET, hiddenWork, OUT, predictTiming, type GenRecord } from "./generate";
import { cookView, fromPayload, line, loadMeals, summarize } from "./kflags";
import { uncutInPayload } from "./knife";
import { TARGETS } from "./targets";

// Batch 1 is regenerated where batch 1's audit found knife work in a note (v2 prompt); 37, 79 and
// 107 had none and are kept from the first run. Batches 2–5 take the remaining concepts in list order.
const B1_KEEP = [37, 79, 107];
const B1_FIRST = [1, 2, 7, 14, 28, 31, 36, 37, 43, 45, 50, 51, 57, 59, 66, 79, 81, 99, 107, 110];
const B1_REGEN = [1, 2, 7, 31, 36, 43, 45, 50, 51, 57, 59, 66, 81, 99, 110];
const rest = TARGETS.map((t) => t.n).filter((n) => !B1_FIRST.includes(n));
const PLAN: Record<number, number[]> = { 1: B1_REGEN, 2: rest.slice(0, 20), 3: rest.slice(20, 40), 4: rest.slice(40, 60), 5: rest.slice(60) };

const LOG = join(OUT, "run.log");
const say = (s: string) => { console.log(s); appendFileSync(LOG, `${s}\n`); };
const node = (script: string, args: string[]) => execFileSync(process.execPath, ["--env-file=.env", "--import", "tsx", `scripts/cat-quick-1/${script}`, ...args], { encoding: "utf8", env: { ...process.env, RESEND_API_KEY: "", LIFECYCLE_EMAIL_ENABLED: "false", LOG_LEVEL: "error" }, maxBuffer: 64 * 1024 * 1024 });
// The checks are recomputed from the payload on every read, so a detector fix applies to saved runs.
const read = (label: string): GenRecord[] => (JSON.parse(readFileSync(join(OUT, label, "gen.json"), "utf8")) as GenRecord[]).map((r) => {
  const t = TARGETS.find((x) => x.n === r.n)!;
  return { ...r, predicted: predictTiming(r.payload), hidden: hiddenWork(r.payload, t), uncut: uncutInPayload(r.payload) };
});
// Resumable: a label whose run.json exists is not generated again.
const generated = (label: string) => existsSync(join(OUT, label, "run.json"));
const timeOk = (r: GenRecord) => r.predicted.total !== null && r.predicted.total <= BUDGET.totalMinutes;

async function main() {
  const argv = process.argv.slice(2);
  const batches = (argv[argv.indexOf("--batches") + 1] ?? "").split(",").map(Number).filter(Boolean);
  mkdirSync(OUT, { recursive: true });

  const prisma = new PrismaClient();
  const catalog = summarize((await loadMeals(prisma, { userId: null, isArchived: false, isPublic: true, activeTimeMinutes: { not: null }, NOT: { tags: { has: "thanksgiving-feast" } } })).map((m) => ({ id: m.id, findings: simulate(cookView(m)).findings })));
  await prisma.$disconnect();
  say(`\n=== run ${new Date().toISOString()} · batches ${batches.join(",")} · ${line("catalog K-flags", catalog)}`);

  for (const b of batches) {
    const ids = PLAN[b];
    const first = `b${b}v2`, rework = `b${b}v2-rework`, batch = `batch${b}`;
    say(`\n--- batch ${b}: ${ids.length} concepts (${ids.join(",")})`);
    if (!generated(first)) say(node("generate.ts", ["--label", first, "--ids", ids.join(",")]).trim());
    const pass1 = read(first);
    const timed = pass1.filter(timeOk).length;
    const rate = timed / ids.length;
    say(`first pass: ${timed}/${ids.length} stamp ≤${BUDGET.totalMinutes} (${(100 * rate).toFixed(0)}%) · accepted ${pass1.filter(accepted).length}/${ids.length}`);
    if (rate < 0.7) { say(`STOP: batch ${b} fails the 7-of-10 rule`); process.exit(2); }

    const redo = ids.filter((n) => !pass1.some((r) => r.n === n && accepted(r)));
    const labels = b === 1 ? ["batch1-v1", first] : [first];
    if (redo.length) {
      if (!generated(rework)) say(node("generate.ts", ["--label", rework, "--ids", redo.join(","), "--rework", first]).trim());
      labels.push(rework);
    }
    const by = new Map<number, GenRecord>();
    if (b === 1) for (const r of read("batch1-v1")) if (B1_KEEP.includes(r.n)) by.set(r.n, r);
    for (const l of labels.slice(b === 1 ? 1 : 0)) for (const r of read(l)) by.set(r.n, r);
    const all = [...by.values()].sort((x, y) => x.n - y.n);
    const ok = all.filter(accepted);
    mkdirSync(join(OUT, batch), { recursive: true });
    writeFileSync(join(OUT, batch, "gen.json"), JSON.stringify(ok, null, 1));
    for (const r of all) say(`  #${String(r.n).padStart(3)} ${accepted(r) ? "ACCEPT" : "DROP  "} ${String(r.predicted.total).padStart(3)}/${String(r.predicted.active).padStart(2)} · ${r.predicted.steps} steps · ${r.predicted.dishes} dishes${r.rework ? " · rework" : ""} · ${r.title}${r.hidden?.length ? ` · hidden ${r.hidden.join(", ")}` : ""}${r.uncut?.length ? ` · uncut ${r.uncut.join("; ")}` : ""}`);
    const total = b === 1 ? 20 : ids.length;
    say(`batch ${b}: ${ok.length}/${total} accepted`);

    const k = summarize(ok.map((r) => ({ id: `#${r.n}`, findings: simulate(cookView(fromPayload(`#${r.n}`, r.payload))).findings })));
    say(line(`batch ${b} K-flags`, k));
    say(`  signatures: ${Object.entries(k.bySig).map(([s, n]) => `${s} ${n}`).join(" · ") || "none"}`);
    if (k.perMeal > catalog.perMeal) { say(`STOP: batch ${b} is worse than the catalog on K-flags (${k.perMeal.toFixed(2)} > ${catalog.perMeal.toFixed(2)})`); process.exit(3); }

    say(node("write.ts", ["--label", batch, "--apply"]).trim());
  }
  say(`\n=== done · spend ${readFileSync(join(OUT, "spend.json"), "utf8")}`);
}
main().catch((e) => { say(`ERROR ${(e as Error).stack ?? e}`); process.exit(1); });
