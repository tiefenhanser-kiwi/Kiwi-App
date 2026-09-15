// WS9 D-WS9-242 — the $0 effort-class derivation: assembly | cooking | craft per
// swappable component, from the phase tags on its SCRATCH-path steps, stamped
// into Dish.componentRegistry[<entry with key>].effortClass (+ effortClassSource
// "derived-v1"). Re-runnable, idempotent, dry by default.
//
//   node --env-file=.env --import tsx scripts/ws9-242/derive_class.ts                  # dry: counts + unresolvable + time snapshot
//   node --env-file=.env --import tsx scripts/ws9-242/derive_class.ts --apply          # pre-image → write in batches of 100 → re-read + assert
//   node --env-file=.env --import tsx scripts/ws9-242/derive_class.ts --apply --dish-ids <id,id,…>   # scope to these dishes
//   node --env-file=.env --import tsx scripts/ws9-242/derive_class.ts --sample25      # also print the seed-270 random-25 table
//
// Population = every Dish with ≥ 1 componentRegistry entry, regardless of Meal.userId
// (the class is a fact about the component); the public / km30- / private split is reported.
// Scratch steps of a component = RecipeInstructionStep rows with componentKey = entry.key AND
// pathKey = 'scratch' (Phase 0.4: the registry is an array of {key,label,order}; the step
// indices are on the tagged step rows, not in the registry).
//
// ⚠️ SHARED CATALOG (D-WS9-230): --apply writes the pre-image of every touched registry to
// scripts/output/ws9-242/preimage_<ts>.json FIRST; revert_class.ts --apply restores from it.
// Nothing else is touched: no step, no time, no key/label/order.
import { Prisma, PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { classifyEffort, EFFORT_CLASS_SOURCE, HEAT_MIN_MINUTES, PHASE_KIND, type EffortClass, type StepPhaseName } from "../../src/lib/effortClass";
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
import { mulberry32 } from "../ws9-239/common.js";

const OUT = "scripts/output/ws9-242";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SAMPLE25 = argv.includes("--sample25");
const idsIdx = argv.indexOf("--dish-ids");
const ONLY = idsIdx >= 0 ? new Set(argv[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)) : null;
const BATCH = 100;

type RegEntry = { key: string; label?: string; order?: number; effortClass?: EffortClass; effortClassSource?: string; [k: string]: unknown };

const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host} · mode ${APPLY ? "APPLY (writes componentRegistry)" : "DRY (no writes)"}${ONLY ? ` · scoped to ${ONLY.size} dish ids` : ""}`);
console.log(`phase map (StepPhase → kind): ${Object.entries(PHASE_KIND).map(([k, v]) => `${k}→${v}`).join("  ")} · class source "${EFFORT_CLASS_SOURCE}"`);

// ── load ────────────────────────────────────────────────────────────────────
const dishes = (await prisma.dish.findMany({
  where: { componentRegistry: { not: Prisma.DbNull }, ...(ONLY ? { id: { in: [...ONLY] } } : {}) },
  select: { id: true, title: true, userId: true, componentRegistry: true, mealLinks: { select: { meal: { select: { userId: true, dishFamilyKey: true } } } } },
})).filter((d) => Array.isArray(d.componentRegistry) && (d.componentRegistry as unknown[]).length > 0);
const dishIds = dishes.map((d) => d.id);
const steps = await prisma.recipeInstructionStep.findMany({
  where: { ownerType: "dish", ownerId: { in: dishIds }, componentKey: { not: null } },
  select: { ownerId: true, stepIndex: true, phaseType: true, estimatedMinutes: true, componentKey: true, pathKey: true, stepTextRaw: true },
  orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
});
const byDish = new Map<string, typeof steps>();
for (const s of steps) byDish.set(s.ownerId, [...(byDish.get(s.ownerId) ?? []), s]);

const split = (d: (typeof dishes)[number]) => (d.mealLinks.some((l) => (l.meal.dishFamilyKey ?? "").startsWith("km30-")) ? "km30" : d.mealLinks.some((l) => l.meal.userId === null) ? "public" : "private");

// ── derive ──────────────────────────────────────────────────────────────────
type Row = { dishId: string; title: string; key: string; label: string; split: string; scratch: typeof steps; cls: EffortClass | null; heatMinutes: number; cookPhases: string[]; craftBy: string[]; current?: EffortClass; changed: boolean };
const rows: Row[] = [];
const unresolvable: Row[] = [];
for (const d of dishes) {
  const reg = d.componentRegistry as RegEntry[];
  const ss = byDish.get(d.id) ?? [];
  for (const e of reg) {
    const scratch = ss.filter((s) => s.componentKey === e.key && s.pathKey === "scratch");
    const base: Row = { dishId: d.id, title: d.title, key: e.key, label: e.label ?? "", split: split(d), scratch, cls: null, heatMinutes: 0, cookPhases: [], craftBy: [], current: e.effortClass, changed: false };
    if (scratch.length === 0) { unresolvable.push(base); continue; }
    const r = classifyEffort({ key: e.key, label: e.label }, scratch.map((s) => ({ phaseType: s.phaseType as StepPhaseName, estimatedMinutes: s.estimatedMinutes, text: s.stepTextRaw })));
    base.cls = r.effortClass; base.heatMinutes = r.heatMinutes; base.cookPhases = r.cookPhases; base.craftBy = r.craftBy;
    base.changed = e.effortClass !== r.effortClass || e.effortClassSource !== EFFORT_CLASS_SOURCE;
    rows.push(base);
  }
}
const total = rows.length + unresolvable.length;
const count = (xs: Row[], f: (r: Row) => boolean) => xs.filter(f).length;
console.log(`\ncomponents (registry entries): ${total} on ${dishes.length} dishes · split public=${count([...rows, ...unresolvable], (r) => r.split === "public")} km30=${count([...rows, ...unresolvable], (r) => r.split === "km30")} private=${count([...rows, ...unresolvable], (r) => r.split === "private")}`);
console.log(`resolved: ${rows.length} · assembly=${count(rows, (r) => r.cls === "assembly")} cooking=${count(rows, (r) => r.cls === "cooking")} craft=${count(rows, (r) => r.cls === "craft")} · unresolvable (no scratch steps): ${unresolvable.length} (${((100 * unresolvable.length) / Math.max(1, total)).toFixed(2)}%)`);
console.log(`assembly by shape: all-prep=${count(rows, (r) => r.cls === "assembly" && r.cookPhases.length === 0)} rest-only=${count(rows, (r) => r.cls === "assembly" && r.cookPhases.length > 0 && r.cookPhases.every((p) => p === "rest"))} heat<${HEAT_MIN_MINUTES}min=${count(rows, (r) => r.cls === "assembly" && r.heatMinutes > 0)} · cooking heat minutes: p50=${med(rows.filter((r) => r.cls === "cooking").map((r) => r.heatMinutes))} min=${Math.min(...rows.filter((r) => r.cls === "cooking").map((r) => r.heatMinutes))}`);
console.log(`sensitivity (cooking-or-craft components with heat ≤ N min): ≤2=${count(rows, (r) => r.heatMinutes > 0 && r.heatMinutes <= 2)} ≤3=${count(rows, (r) => r.heatMinutes > 0 && r.heatMinutes <= 3)} ≤4=${count(rows, (r) => r.heatMinutes > 0 && r.heatMinutes <= 4)} ≤5=${count(rows, (r) => r.heatMinutes > 0 && r.heatMinutes <= 5)}`);
console.log(`craft by trigger: name-only=${count(rows, (r) => r.cls === "craft" && r.craftBy.join() === "name")} text-only=${count(rows, (r) => r.cls === "craft" && r.craftBy.join() === "text")} both=${count(rows, (r) => r.cls === "craft" && r.craftBy.length === 2)}`);
console.log(`already stamped identically (idempotent skip): ${count(rows, (r) => !r.changed)} · to write: ${count(rows, (r) => r.changed)}`);
for (const cls of ["assembly", "cooking", "craft"] as const) {
  const keys = new Map<string, number>(); for (const r of rows.filter((x) => x.cls === cls)) keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
  console.log(`  ${cls.padEnd(8)} top keys: ${[...keys].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(" ")}`);
}
if (unresolvable.length) {
  console.log(`unresolvable examples (10):`);
  for (const u of unresolvable.slice(0, 10)) { const ss = byDish.get(u.dishId) ?? []; console.log(`  ${u.dishId} "${u.title.slice(0, 40)}" key=${u.key} · tagged steps for this key: ${ss.filter((s) => s.componentKey === u.key).map((s) => `#${s.stepIndex}:${s.pathKey}`).join(",") || "none"} · other keys on dish: ${[...new Set(ss.map((s) => s.componentKey))].join(",") || "none"}`); }
}

// ── the seed-270 random 25 (Phase F's draw: public dishes, components with a bought path) ──
if (SAMPLE25) {
  const pubDishes = dishes.filter((d) => d.userId === null && d.mealLinks.some((l) => l.meal.userId === null));
  // Phase F drew from `comps` built by iterating pubDishes (findMany order) and, per dish, the
  // distinct componentKeys of its bought steps in step order. Reproduce that exactly.
  const allSteps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: pubDishes.map((d) => d.id) } }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, componentKey: true, pathKey: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
  const bd = new Map<string, typeof allSteps>(); for (const s of allSteps) bd.set(s.ownerId, [...(bd.get(s.ownerId) ?? []), s]);
  const comps: { dishId: string; key: string; scratchMin: number; boughtMin: number }[] = [];
  for (const d of pubDishes) { const ss = bd.get(d.id) ?? []; for (const key of [...new Set(ss.filter((s) => s.pathKey === "bought").map((s) => s.componentKey as string))]) comps.push({ dishId: d.id, key, scratchMin: ss.filter((s) => s.componentKey === key && s.pathKey === "scratch").reduce((a, s) => a + s.estimatedMinutes, 0), boughtMin: ss.filter((s) => s.componentKey === key && s.pathKey === "bought").reduce((a, s) => a + s.estimatedMinutes, 0) }); }
  const rnd = mulberry32(270); const arr = [...comps]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  console.log(`\nSAMPLE-25 (seed 270 over ${comps.length} public components with a bought path — Phase F's population was 1644):`);
  const byKey = new Map(rows.map((r) => [`${r.dishId}|${r.key}`, r]));
  let n = 0;
  for (const c of arr.slice(0, 25)) {
    n++;
    const r = byKey.get(`${c.dishId}|${c.key}`);
    console.log(`\n[${n}] "${r?.title ?? "?"}" · ${c.key} · saved ${c.scratchMin - c.boughtMin} (${c.scratchMin}→${c.boughtMin}) · dish ${c.dishId} · DERIVED: ${r?.cls ?? "UNRESOLVED"}${r?.cookPhases.length ? ` (${r.cookPhases.join("+")}, heat ${r.heatMinutes}m)` : ""}${r?.craftBy.length ? ` craft-by ${r.craftBy.join("+")}` : ""}`);
    for (const s of r?.scratch ?? []) console.log(`     #${s.stepIndex} ${s.phaseType.padEnd(8)} ${String(s.estimatedMinutes).padStart(3)}m  ${s.stepTextRaw}`);
  }
}

// ── time snapshot (2.4): the stamp must not move any stored time ─────────────
mkdirSync(OUT, { recursive: true });
const SNAP = `${OUT}/time_snapshot.json`;
const times = await prisma.meal.findMany({ select: { id: true, estimatedTimeMinutes: true, activeTimeMinutes: true } });
if (!APPLY) {
  writeFileSync(SNAP, JSON.stringify({ takenAt: new Date().toISOString(), n: times.length, times: Object.fromEntries(times.map((t) => [t.id, [t.estimatedTimeMinutes, t.activeTimeMinutes]])) }));
  console.log(`\ntime snapshot: ${times.length} meals → ${SNAP}`);
}

// ── apply ───────────────────────────────────────────────────────────────────
if (!APPLY) { console.log(`\nDRY — nothing written. Re-run with --apply.`); await prisma.$disconnect(); process.exit(0); }
if (unresolvable.length / Math.max(1, total) > 0.05) { console.log(`🔴 REFUSING --apply: unresolvable ${unresolvable.length}/${total} exceeds 5%`); await prisma.$disconnect(); process.exit(2); }

const touched = new Map<string, { before: RegEntry[]; after: RegEntry[] }>();
for (const d of dishes) {
  const reg = d.componentRegistry as RegEntry[];
  const mine = rows.filter((r) => r.dishId === d.id && r.changed);
  if (mine.length === 0) continue;
  const after = reg.map((e) => { const r = mine.find((x) => x.key === e.key); return r ? { ...e, effortClass: r.cls as EffortClass, effortClassSource: EFFORT_CLASS_SOURCE } : e; });
  touched.set(d.id, { before: reg, after });
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const PRE = `${OUT}/preimage_${ts}.json`;
writeFileSync(PRE, JSON.stringify({ writtenAt: new Date().toISOString(), source: EFFORT_CLASS_SOURCE, dishes: Object.fromEntries([...touched].map(([id, t]) => [id, t.before])) }));
const { size } = await import("node:fs").then((m) => m.statSync(PRE));
console.log(`\npre-image: ${PRE} (${size} bytes, ${touched.size} dishes)`);

const ids = [...touched.keys()];
let written = 0;
for (let i = 0; i < ids.length; i += BATCH) {
  const batch = ids.slice(i, i + BATCH);
  await prisma.$transaction(batch.map((id) => prisma.dish.update({ where: { id }, data: { componentRegistry: touched.get(id)!.after as unknown as Prisma.InputJsonValue }, select: { id: true } })));
  written += batch.length;
  console.log(`  wrote ${written}/${ids.length}`);
}

// re-read + assert every stamped value
const back = await prisma.dish.findMany({ where: { id: { in: ids } }, select: { id: true, componentRegistry: true } });
let bad = 0;
for (const b of back) { const want = touched.get(b.id)!.after; if (JSON.stringify(b.componentRegistry) !== JSON.stringify(want)) { bad++; if (bad <= 5) console.log(`  🔴 mismatch on ${b.id}: got ${JSON.stringify(b.componentRegistry)}`); } }
const stamped = rows.filter((r) => r.changed);
console.log(`re-read: ${back.length}/${ids.length} dishes · mismatches ${bad} · components stamped ${stamped.length} (assembly=${count(stamped, (r) => r.cls === "assembly")} cooking=${count(stamped, (r) => r.cls === "cooking")} craft=${count(stamped, (r) => r.cls === "craft")})`);

// time check against the dry snapshot
if (existsSync(SNAP)) {
  const snap = JSON.parse(await import("node:fs").then((m) => m.readFileSync(SNAP, "utf8"))) as { takenAt: string; times: Record<string, [number, number | null]> };
  const after = await prisma.meal.findMany({ select: { id: true, estimatedTimeMinutes: true, activeTimeMinutes: true } });
  let moved = 0, missing = 0;
  for (const m of after) { const s = snap.times[m.id]; if (!s) { missing++; continue; } if (s[0] !== m.estimatedTimeMinutes || s[1] !== m.activeTimeMinutes) moved++; }
  console.log(`time check vs snapshot ${snap.takenAt}: meals whose estimatedTimeMinutes/activeTimeMinutes moved = ${moved} · meals not in snapshot = ${missing}`);
}
console.log(`revert: node --env-file=.env --import tsx scripts/ws9-242/revert_class.ts --file ${PRE} --apply`);
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
