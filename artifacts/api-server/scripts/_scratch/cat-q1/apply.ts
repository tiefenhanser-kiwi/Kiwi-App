// CAT-Q1 — the writes. A DRY RUN unless --apply. One transaction per meal; in
// it: the meal's full row graph read (the pre-image), the change, the graph
// read again (its hash is the post-image revert.ts checks before restoring).
// The revert file (out/<mode>/revert-<part>-<stamp>.json) is rewritten after
// every committed meal, so an interrupted run is still revertible.
//
//   Part A  archive the prisma/seed.ts meals (r-buddha … r-tofu). Every
//           reference is reported first — template items (Featured plans
//           named), plan items, favorites, playlist rows — and a referenced
//           meal is NOT archived. isArchived only; nothing is deleted.
//   Part B  partB.ts over the whole catalog (dev or production as it stands).
//   Part C  the ACCEPTED patches plan.ts wrote for this database
//           (out/<mode>/patches/*.json; --set pilot|rest or --ids). Each
//           patch's B edits first (idempotent), then its C edits. Any `old`
//           that no longer matches → the meal is skipped and reported.
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/apply.ts --part A|B|C [--set pilot|rest] [--ids a,b] [--apply]
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { CATALOG_WHERE, loadCatalog } from "../cat-q0/catalogDb";
import { applyEdits, applyPatch, StaleEdit, type Edit } from "./edits";
import { graphHash, readGraph, type MealGraph } from "./graph";
import { OUT, pilotIds, readIssues, restIds, SEED_IDS } from "./issues";
import { partBEdits } from "./partB";

const has = (k: string) => process.argv.includes(k);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PART = arg("--part", "");
const APPLY = has("--apply");
if (!["A", "B", "C"].includes(PART)) throw new Error("--part A|B|C");

const { host, mode } = assertScriptDatabase(`cat-q1/apply-${PART}`);
const DIR = join(OUT, mode);
mkdirSync(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const lines: string[] = [];
const say = (s = "") => { console.log(s); lines.push(s); };
say(`database: ${host} (${mode}) · part ${PART} · ${APPLY ? "APPLY" : "dry run — nothing is written"}`);
const prisma = new PrismaClient();

interface RevertEntry { mealId: string; title: string; preHash: string; postHash: string; pre: MealGraph }
const revertFile = join(DIR, `revert-${PART}-${stamp}.json`);
const reverts: RevertEntry[] = [];
const saveReverts = () => writeFileSync(revertFile, JSON.stringify({ part: PART, mode, host, at: stamp, meals: reverts }, null, 1));

/** One meal, one transaction: pre-image, change, post-image. */
async function write(mealId: string, title: string, change: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<string>): Promise<string> {
  const r = await prisma.$transaction(async (tx) => {
    const pre = await readGraph(tx, mealId);
    if (!pre) throw new StaleEdit([`meal ${mealId} is gone`]);
    const what = await change(tx);
    const post = await readGraph(tx, mealId);
    return { what, entry: { mealId, title, preHash: graphHash(pre), postHash: graphHash(post), pre } };
  }, { timeout: 120_000, maxWait: 30_000 });
  // committed: only now does it belong in the revert file
  reverts.push(r.entry);
  saveReverts();
  return r.what;
}

// ── Part A ──────────────────────────────────────────────────────────────────
if (PART === "A") {
  const rows = await prisma.meal.findMany({
    where: { id: { in: [...SEED_IDS] } },
    select: {
      id: true, title: true, isPublic: true, isArchived: true,
      templateItems: { select: { mealPlanTemplateId: true, template: { select: { title: true } } } },
      planItems: { select: { id: true } }, favorites: { select: { id: true } }, playlistMeals: { select: { id: true } },
    },
    orderBy: { id: "asc" },
  });
  say(`seed meals found ${rows.length}/${SEED_IDS.length}${rows.length < SEED_IDS.length ? ` · absent: ${SEED_IDS.filter((id) => !rows.some((r) => r.id === id)).join(", ")}` : ""}`);
  const todo: typeof rows = [];
  for (const r of rows) {
    const refs = [
      ...r.templateItems.map((t) => `template item in ${t.mealPlanTemplateId}${t.mealPlanTemplateId.startsWith("featured-") ? " (FEATURED)" : ""} "${t.template.title}"`),
      ...(r.planItems.length ? [`${r.planItems.length} plan item(s)`] : []),
      ...(r.favorites.length ? [`${r.favorites.length} favorite(s)`] : []),
      ...(r.playlistMeals.length ? [`${r.playlistMeals.length} playlist row(s)`] : []),
    ];
    const state = `public=${r.isPublic} archived=${r.isArchived}`;
    if (r.isArchived) say(`  ${r.id.padEnd(13)} "${r.title}" — already archived; skipped`);
    else if (refs.length) say(`  ${r.id.padEnd(13)} "${r.title}" — ${state} — REFERENCED, not archived: ${refs.join("; ")}`);
    else { say(`  ${r.id.padEnd(13)} "${r.title}" — ${state} — no references → archive`); todo.push(r); }
  }
  if (APPLY) {
    for (const r of todo) {
      await write(r.id, r.title, async (tx) => {
        // the reference check again, inside the transaction
        const n = await tx.meal.findUnique({ where: { id: r.id }, select: { _count: { select: { templateItems: true, planItems: true, favorites: true, playlistMeals: true } } } });
        const c = n!._count;
        if (c.templateItems + c.planItems + c.favorites + c.playlistMeals > 0) throw new StaleEdit([`${r.id} gained a reference: ${JSON.stringify(c)}`]);
        const u = await tx.meal.updateMany({ where: { id: r.id, isArchived: false }, data: { isArchived: true } });
        if (u.count !== 1) throw new StaleEdit([`${r.id} was archived meanwhile`]);
        return "archived";
      }).then((w) => say(`  ${r.id}: ${w}`), (e) => say(`  ${r.id}: SKIPPED — ${e instanceof StaleEdit ? e.message : String(e)}`));
    }
  }
  say(`part A: ${todo.length} to archive${APPLY ? ` · archived ${reverts.length}` : ""}`);
}

// ── Part B ──────────────────────────────────────────────────────────────────
if (PART === "B") {
  const catalog = await loadCatalog(prisma, has("--ids") ? arg("--ids", "").split(",") : undefined);
  const plan = catalog.map((m) => ({ m, ...partBEdits(m) }));
  const edits = plan.flatMap((p) => p.edits);
  const rules = new Map<string, { edits: number; meals: Set<string> }>();
  for (const p of plan) for (const e of p.edits) { const r = rules.get(e.rule!) ?? { edits: 0, meals: new Set() }; r.edits++; r.meals.add(p.m.id); rules.set(e.rule!, r); }
  say(`catalog ${catalog.length} meals · B edits ${edits.length} in ${plan.filter((p) => p.edits.length).length} meals`);
  for (const [k, v] of rules) say(`  ${k.padEnd(14)} ${v.edits} edits in ${v.meals.size} meals`);
  const skips = plan.flatMap((p) => p.skips);
  say(`  not done (reported): ${skips.length}`);
  for (const s of skips) say(`    [${s.rule}] ${s.mealId} ${s.dish} — ${s.detail}`);
  const detail: string[] = [];
  for (const p of plan.filter((x) => x.edits.length)) {
    detail.push(`═══ ${p.m.title} — ${p.m.id}`);
    for (const e of p.edits) detail.push(describe(e));
  }
  writeFileSync(join(DIR, `partB-${APPLY ? "apply" : "dry"}-${stamp}.txt`), [...lines, "", ...detail].join("\n"));
  say(`every edit, old → new: out/${mode}/partB-${APPLY ? "apply" : "dry"}-${stamp}.txt`);
  if (APPLY) {
    let ok = 0, already = 0, stale = 0;
    for (const p of plan.filter((x) => x.edits.length)) {
      await write(p.m.id, p.m.title, async (tx) => { const r = await applyEdits(tx, p.m.id, p.edits); already += r.already; return `${r.applied} applied`; })
        .then(() => ok++, (e) => { stale++; say(`  ${p.m.id}: SKIPPED — ${e instanceof StaleEdit ? e.message : String(e)}`); });
    }
    say(`part B applied: ${ok} meals · already ${already} edits · skipped ${stale} meals`);
  }
}

// ── Part C ──────────────────────────────────────────────────────────────────
if (PART === "C") {
  const pdir = join(DIR, "patches");
  if (!existsSync(pdir)) throw new Error(`no patches for ${mode}: run plan.ts first`);
  const issues = readIssues();
  const want = new Set(has("--ids") ? arg("--ids", "").split(",") : arg("--set", "") === "rest" ? restIds(issues) : arg("--set", "") === "pilot" ? pilotIds(issues) : []);
  if (!want.size) throw new Error("--set pilot|rest or --ids");
  const all = readdirSync(pdir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(pdir, f), "utf8")) as { mealId: string; title: string; mode: string; host: string; status: string; edits: Edit[]; graphAtPlan?: string })
    .filter((p) => want.has(p.mealId));
  const byStatus = new Map<string, number>();
  for (const p of all) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  say(`patches in the set: ${all.length} (${[...byStatus].map(([k, v]) => `${k} ${v}`).join(" · ")}) — only "accepted" is applied`);
  const patches = all.filter((p) => p.status === "accepted");
  for (const p of patches) if (p.mode !== mode || p.host !== host) throw new Error(`patch ${p.mealId} was planned on ${p.host} (${p.mode}), not ${host}: refusing`);
  say(`accepted patches in the set: ${patches.length}`);
  const live = new Set((await prisma.meal.findMany({ where: { ...CATALOG_WHERE, id: { in: patches.map((p) => p.mealId) } }, select: { id: true } })).map((m) => m.id));
  let ok = 0, stale = 0;
  for (const p of patches) {
    const n = (f: (e: Edit) => boolean) => p.edits.filter(f).length;
    // read-only: is the row graph still the one plan.ts read? (if not, apply verifies every old and skips a stale meal)
    const now = live.has(p.mealId) ? graphHash(await readGraph(prisma, p.mealId)) : null;
    const since = !p.graphAtPlan ? "" : now === p.graphAtPlan ? " · unchanged since plan" : " · MOVED since plan — every old is re-checked at apply";
    say(`  ${p.mealId} "${p.title}" — B ${n((e) => e.source === "B")} · C round 1 ${n((e) => e.source === "C" && (e.round ?? 1) === 1)} · round 2 ${n((e) => e.round === 2)}${live.has(p.mealId) ? since : " — NOT IN THE CATALOG NOW"}`);
    if (!APPLY || !live.has(p.mealId)) continue;
    await write(p.mealId, p.title, async (tx) => {
      const [rb, r1, r2] = await applyPatch(tx, p.mealId, p.edits);
      return `B ${rb.applied} applied (${rb.already} already) · C round 1 ${r1.applied} · round 2 ${r2.applied}`;
    }).then((w) => { ok++; say(`    ${w}`); }, (e) => { stale++; say(`    SKIPPED — ${e instanceof StaleEdit ? e.message : String(e)}`); });
  }
  say(`part C${APPLY ? ` applied ${ok} · skipped ${stale}` : ": dry run"}`);
}

function describe(e: Edit): string {
  const f = (x: { quantity: number; unit: string; name: string; preparationNote?: string | null } | null) => (x ? `${Number(x.quantity.toFixed(4))} ${x.unit} ${x.name}${x.preparationNote ? ` (${x.preparationNote})` : ""}` : "(removed)");
  if (e.kind === "step") return `  [${e.rule}] ${e.dishTitle} step ${e.stepIndex}\n      old: ${e.old.text}\n      new: ${e.new.text}`;
  if (e.kind === "ingredient") return `  [${e.rule}] ${e.dishTitle} — ${f(e.old)} → ${f(e.new)}`;
  if (e.kind === "new_ingredient") return `  [${e.rule}] ${e.dishTitle} — NEW ${f(e.new)}`;
  return `  [${e.rule}] ${e.dishTitle} — swap removed: ${e.old.quantity} ${e.old.unit} ${e.old.product} (replaces ${e.old.replaces.join(", ")})`;
}

if (APPLY && reverts.length) say(`revert file: ${revertFile} (${reverts.length} meals)`);
writeFileSync(join(DIR, `apply-${PART}-${APPLY ? "apply" : "dry"}-${stamp}.txt`), lines.join("\n"));
await prisma.$disconnect();
