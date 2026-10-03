// [prepcook] Part I — the corpus, chosen by SHAPE.
//
// Four live plans already on the test account, plus plans ASSEMBLED on the same
// account from PUBLIC catalog meals (a MealPlanInstance with meals and assigned
// days — no wizard, no AI). Idempotent: an assembled plan is found again by its
// title, so a re-run reuses it rather than minting a second one.
//
//   # print the corpus table (no writes)
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/corpus.ts
//   # create whatever assembled plans are missing (writes, TEST ACCOUNT ONLY)
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/corpus.ts --assemble
//
// ── fences ──────────────────────────────────────────────────────────────────
//   • dev branch only (`ep-broad-haze`);
//   • every write names TEST_USER_ID as owner — Hans's rows are read, never written;
//   • `e55a9305` (Hans preps from it Sunday) is refused by id anywhere it appears.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { shapeMeals, type Shape } from "./shapes";

export const TEST_USER_ID = "64981080-bd9f-4324-9c28-20bca82bb806"; // kiwi-browser-test-0930a@example.com
export const FORBIDDEN_PLAN = "e55a9305-2695-4c16-a25e-effcc03fc109";
const HERE = dirname(fileURLToPath(import.meta.url));

/** The live plans already on the test account (the browser pass's own rows). */
export const EXISTING = ["1e41fc0c", "b4aa6fee", "b5263268", "1cf373bc"];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
type Day = (typeof DAYS)[number];
/** Assembled plans start on the Sunday after today, so days 5–7 are Thu/Fri/Sat. */
const START = "2026-10-04";

interface Spec {
  code: string;
  label: string;
  meals: [Day, string][]; // [day, catalog meal id prefix]
  /** componentKeys to set to `bought` on that meal's plan item (the per-plan selection). */
  boughtSelections?: string[];
}

export const SPECS: Spec[] = [
  { code: "A01", label: "7 meals, Sun–Sat: marinades, seafood, slaw", meals: [
    ["Sunday", "3fc5e05a"], ["Monday", "6d90312d"], ["Tuesday", "183807be"], ["Wednesday", "354dbaa0"],
    ["Thursday", "c408e949"], ["Friday", "7096250b"], ["Saturday", "19c3d489"]] },
  { code: "A02", label: "7 meals, Sun–Sat: slow cooker, cornbread, seafood late", meals: [
    ["Sunday", "73b62c74"], ["Monday", "0c900348"], ["Tuesday", "6b780599"], ["Wednesday", "822261c3"],
    ["Thursday", "e33227e5"], ["Friday", "5df3314d"], ["Saturday", "22614b9f"]] },
  { code: "A03", label: "2 meals: pizza + chicken salad (single-dish)", meals: [
    ["Sunday", "51b9629a"], ["Thursday", "64a266c6"]] },
  { code: "A04", label: "2 meals: shrimp tacos + al pastor (late)", meals: [
    ["Monday", "3d589ae1"], ["Saturday", "a88f5064"]] },
  { code: "A05", label: "late-week proteins: smoker, braise, gyros, salmon", meals: [
    ["Wednesday", "b014a9b3"], ["Thursday", "2d05fb39"], ["Friday", "7f104a58"], ["Saturday", "e32ec6dd"]] },
  { code: "A06", label: "slow cooker + slaws + curry + stew", meals: [
    ["Sunday", "de07e9c7"], ["Tuesday", "aeb89b37"], ["Thursday", "3e205257"], ["Friday", "293ceff5"], ["Saturday", "4f738c95"]] },
  { code: "A07", label: "bought paths: bottled marinades, store guac, slaw mix, rotisserie", meals: [
    ["Sunday", "bdda7211"], ["Monday", "08c7483a"], ["Wednesday", "c7947a22"], ["Friday", "558f0469"], ["Saturday", "9cd9315a"]],
    boughtSelections: ["guac", "slaw-base"] },
  { code: "A08", label: "rotisserie + bagged slaw", meals: [
    ["Monday", "6263e796"], ["Tuesday", "e96ee78f"], ["Thursday", "d699cd4a"], ["Saturday", "cd98969a"]] },
  { code: "A09", label: "ginger / scallion / raw tuna", meals: [
    ["Sunday", "08c70fd1"], ["Tuesday", "ea034ba1"], ["Wednesday", "cf774d74"], ["Friday", "3aff6b9d"]] },
  { code: "A10", label: "doughs and breads: pizza, biscuits, flatbread", meals: [
    ["Sunday", "443f992c"], ["Tuesday", "da57132f"], ["Thursday", "ab06a806"], ["Saturday", "2b578f56"]] },
  { code: "A11", label: "single-dish week", meals: [
    ["Sunday", "4dcf3152"], ["Monday", "8573b172"], ["Wednesday", "957696fb"], ["Thursday", "409edbca"], ["Saturday", "38690cac"]] },
  { code: "A12", label: "roast chicken + roasted green beans (toss)", meals: [
    ["Sunday", "44fdb3f3"], ["Tuesday", "b873f58d"], ["Thursday", "e251f17b"], ["Saturday", "2b92d80e"]] },
  { code: "A13", label: "taco week: pico, corn salsa, jalapeño slaw", meals: [
    ["Monday", "c2a53d20"], ["Tuesday", "93abf555"], ["Thursday", "c6545fd7"], ["Saturday", "7720fbf4"]] },
  { code: "A14", label: "curries: marinades, raita, naan", meals: [
    ["Sunday", "994049b6"], ["Wednesday", "3203f02d"], ["Friday", "4f01bac1"], ["Saturday", "5a86456e"]] },
  { code: "A15", label: "pulled pork three ways", meals: [
    ["Sunday", "a7bd94ec"], ["Wednesday", "71b73681"], ["Saturday", "316a9cc7"]] },
  { code: "A16", label: "seafood: shrimp bowl, seared tuna, catfish, salmon", meals: [
    ["Monday", "76159338"], ["Wednesday", "d6398bb5"], ["Thursday", "a3373d4d"], ["Saturday", "44e2446d"]] },
  { code: "A17", label: "Mediterranean: kofta, dolmades, shawarma, gyros", meals: [
    ["Sunday", "57401f7b"], ["Tuesday", "aed5d088"], ["Thursday", "3020b70c"], ["Friday", "fdc9a12a"]] },
  { code: "A18", label: "comfort: pot roast, biscuits, pasta, chicken parm", meals: [
    ["Sunday", "29e6318d"], ["Tuesday", "670ae2c2"], ["Wednesday", "6df8789d"], ["Friday", "32d1510f"], ["Saturday", "43bc4656"]] },
  { code: "A19", label: "grill: halves, skewers, spatchcock, shrimp tacos", meals: [
    ["Sunday", "3db20bcd"], ["Tuesday", "3520fd73"], ["Thursday", "8a9e026d"], ["Saturday", "c72731a6"]] },
  { code: "A20", label: "single-dish fajitas, pasta, casserole", meals: [
    ["Sunday", "01c4f79e"], ["Tuesday", "940ac1eb"], ["Thursday", "2d3db7ae"], ["Saturday", "4e7b5af5"]] },
  { code: "A21", label: "braises + flautas", meals: [
    ["Sunday", "459a17db"], ["Monday", "489505d3"], ["Wednesday", "9d0f05c9"], ["Friday", "e2205287"], ["Saturday", "7d39dc40"]] },
];

export const titleOf = (s: Spec) => `Part I · ${s.code} · ${s.label}`;

function dateOf(day: Day): Date {
  const start = Date.parse(`${START}T00:00:00Z`); // a Sunday
  return new Date(start + DAYS.indexOf(day) * 86_400_000);
}

export interface CorpusRow {
  planId: string;
  code: string;
  label: string;
  startDate: string | null;
  meals: { mealId: string; title: string; day: string | null; dishCount: number; shapes: Shape[] }[];
  planShapes: string[];
}

/** Plan-level shapes on top of the meal shapes. */
function planShapes(meals: CorpusRow["meals"], startDate: string | null): string[] {
  const out: string[] = [];
  const n = meals.length;
  if (n === 2) out.push("plan-2-meals");
  if (n >= 7) out.push("plan-7-meals");
  if (startDate) {
    const startDow = new Date(`${startDate}T00:00:00Z`).getUTCDay();
    const late = meals.some((m) => {
      const d = m.day ? DAYS.indexOf(m.day as Day) : -1;
      return d >= 0 && (d - startDow + 7) % 7 >= 4; // days 5–7
    });
    if (late) out.push("days-5-7");
  }
  return out;
}

export async function loadCorpus(prisma: PrismaClient): Promise<CorpusRow[]> {
  const rows: CorpusRow[] = [];
  const ids: { id: string; code: string; label: string }[] = [];
  for (const p of EXISTING) {
    const plan = await prisma.mealPlanInstance.findFirst({ where: { id: { startsWith: p }, userId: TEST_USER_ID } });
    if (plan) ids.push({ id: plan.id, code: `E-${p}`, label: plan.titleOverride ?? "" });
  }
  for (const s of SPECS) {
    const plan = await prisma.mealPlanInstance.findFirst({ where: { userId: TEST_USER_ID, titleOverride: titleOf(s), compostedAt: null } });
    if (plan) ids.push({ id: plan.id, code: s.code, label: s.label });
  }
  for (const { id, code, label } of ids) {
    if (id === FORBIDDEN_PLAN) throw new Error("REFUSING: the corpus contains e55a9305");
    const plan = await prisma.mealPlanInstance.findUniqueOrThrow({
      where: { id },
      select: { startDate: true, items: { orderBy: { positionIndex: "asc" }, select: { mealId: true, assignedDayOfWeek: true } } },
    });
    const loaded = await prisma.meal.findMany({
      where: { id: { in: plan.items.map((i) => i.mealId) } },
      select: {
        id: true, title: true, isPublic: true, userId: true,
        dishLinks: { orderBy: { positionIndex: "asc" }, select: { dish: { select: { id: true, title: true, dishIngredients: { select: { preparationNote: true, pathKey: true, componentKey: true, ingredient: { select: { displayName: true } } } } } } } },
      },
    });
    const shaped = await shapeMeals(prisma, loaded);
    const byId = new Map(shaped.map((m) => [m.mealId, m]));
    const meals = plan.items.map((i) => {
      const s = byId.get(i.mealId)!;
      return { mealId: i.mealId, title: s.title, day: i.assignedDayOfWeek, dishCount: s.dishCount, shapes: s.shapes };
    });
    const startDate = plan.startDate?.toISOString().slice(0, 10) ?? null;
    rows.push({ planId: id, code, label, startDate, meals, planShapes: planShapes(meals, startDate) });
  }
  return rows;
}

async function assemble(prisma: PrismaClient) {
  const catalog: { mealId: string }[] = JSON.parse(readFileSync(join(HERE, "out", "catalog-shapes.json"), "utf8"));
  const resolve = (prefix: string) => {
    const hits = catalog.filter((m) => m.mealId.startsWith(prefix));
    if (hits.length !== 1) throw new Error(`catalog prefix ${prefix}: ${hits.length} matches`);
    return hits[0].mealId;
  };
  for (const s of SPECS) {
    const existing = await prisma.mealPlanInstance.findFirst({ where: { userId: TEST_USER_ID, titleOverride: titleOf(s), compostedAt: null } });
    if (existing) { console.log(`${s.code} exists ${existing.id.slice(0, 8)}`); continue; }
    const items = [];
    for (const [i, [day, prefix]] of s.meals.entries()) {
      const mealId = resolve(prefix);
      // The per-plan bought selection: only for a component that HAS a scratch
      // alternative on this meal — otherwise the default already reads bought.
      let componentSelections: Record<string, Record<string, "bought">> | null = null;
      if (s.boughtSelections) {
        const links = await prisma.mealDishLink.findMany({ where: { mealId }, select: { dishId: true } });
        const steps = await prisma.recipeInstructionStep.findMany({
          where: { ownerType: "dish", ownerId: { in: links.map((l) => l.dishId) }, componentKey: { in: s.boughtSelections } },
          select: { ownerId: true, componentKey: true, pathKey: true },
        });
        for (const st of steps) {
          const both = steps.some((o) => o.ownerId === st.ownerId && o.componentKey === st.componentKey && o.pathKey === "scratch") &&
            steps.some((o) => o.ownerId === st.ownerId && o.componentKey === st.componentKey && o.pathKey === "bought");
          if (both && st.componentKey) {
            componentSelections ??= {};
            (componentSelections[st.ownerId] ??= {})[st.componentKey] = "bought";
          }
        }
      }
      items.push({
        mealId,
        positionIndex: i,
        assignedDayOfWeek: day,
        assignedDate: dateOf(day),
        isDinner: true,
        ...(componentSelections ? { componentSelections } : {}),
      });
    }
    const end = new Date(Date.parse(`${START}T00:00:00Z`) + 6 * 86_400_000);
    const plan = await prisma.mealPlanInstance.create({
      data: {
        userId: TEST_USER_ID,
        titleOverride: titleOf(s),
        startDate: new Date(`${START}T00:00:00Z`),
        endDate: end,
        committedAt: new Date(),
        items: { create: items },
      },
    });
    console.log(`${s.code} created ${plan.id}${items.some((x) => "componentSelections" in x) ? " (with bought selections)" : ""}`);
  }
}

async function main() {
  const prisma = new PrismaClient();
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
  try {
    if (process.argv.includes("--assemble")) await assemble(prisma);
    const rows = await loadCorpus(prisma);
    writeFileSync(join(HERE, "out", "corpus.json"), JSON.stringify(rows, null, 2));
    const L: string[] = ["| plan | code | meals | shapes covered |", "|---|---|---|---|"];
    const tally = new Map<string, number>();
    for (const r of rows) {
      const shapes = [...new Set([...r.planShapes, ...r.meals.flatMap((m) => m.shapes)])];
      for (const s of shapes) tally.set(s, (tally.get(s) ?? 0) + 1);
      L.push(`| ${r.planId.slice(0, 8)} | ${r.code} | ${r.meals.map((m) => `${m.title.slice(0, 34)} (${(m.day ?? "-").slice(0, 3)}, ${m.dishCount}d)`).join("; ")} | ${shapes.join(", ")} |`);
    }
    L.push("", "plans per shape: " + [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
    writeFileSync(join(HERE, "out", "corpus.md"), L.join("\n"));
    console.log(L.join("\n"));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
