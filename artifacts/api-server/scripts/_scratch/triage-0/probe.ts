// TRIAGE-0 scratch — READ-ONLY dev probe for BUG-058 / 041 / 245 / 275 / 301.
// No writes. No AI calls. Never prints the database URL.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const envText = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const line = envText.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
let url = (line ?? "").slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
let host = "";
try { host = new URL(url).hostname; } catch { host = ""; }
if (!host.includes("ep-broad-haze")) {
  console.error("not the dev branch; refusing");
  process.exit(2);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });
url = "";

const norm = (t: string) => t.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?,;:'"]+$/g, "");
const since30 = new Date(Date.now() - 30 * 864e5);

async function llmByVersion(promptKey: string, since: Date) {
  const rows = await prisma.lLMCallLog.findMany({
    where: { promptKey, createdAt: { gte: since } },
    select: { promptVersion: true, success: true, retryCount: true, failureReason: true, createdAt: true, latencyMs: true },
  });
  const by = new Map<string, { n: number; fail: number; retried: number; reasons: Record<string, number>; first: string; last: string; p50lat: number[] }>();
  for (const r of rows) {
    const k = String(r.promptVersion);
    const e = by.get(k) ?? { n: 0, fail: 0, retried: 0, reasons: {}, first: "9", last: "0", p50lat: [] };
    e.n++;
    if (!r.success) { e.fail++; e.reasons[r.failureReason ?? "?"] = (e.reasons[r.failureReason ?? "?"] ?? 0) + 1; }
    if (r.retryCount > 0) e.retried++;
    const d = r.createdAt.toISOString().slice(0, 10);
    if (d < e.first) e.first = d; if (d > e.last) e.last = d;
    e.p50lat.push(r.latencyMs);
    by.set(k, e);
  }
  const out: Record<string, unknown> = {};
  for (const [k, e] of by) {
    e.p50lat.sort((a, b) => a - b);
    out[`v${k}`] = { n: e.n, fail: e.fail, retried: e.retried, reasons: e.reasons, range: `${e.first}..${e.last}`, p50LatencyMs: e.p50lat[Math.floor(e.p50lat.length / 2)] };
  }
  return out;
}

async function activeVersion(key: string) {
  const p = await prisma.aIPrompt.findUnique({ where: { key }, select: { versions: { where: { isActive: true }, select: { version: true, createdAt: true } } } });
  return p?.versions;
}

async function main() {
  // ── BUG-058 ──────────────────────────────────────────────────────────
  console.log("=== BUG-058");
  const everyday = { isPublic: true, isArchived: false, NOT: { tags: { hasSome: ["thanksgiving"] } } };
  const catalogN = await prisma.meal.count({ where: everyday });
  console.log("public everyday catalog meals:", catalogN);
  const dc = await prisma.systemSetting.findUnique({ where: { key: "top_rated.display_count" } }).catch(() => null);
  const displayCount = dc ? Number(dc.value) : 20;
  console.log("top_rated.display_count:", dc ? dc.value : "(default 20)");

  // top users by own unarchived meals
  const grouped = await prisma.meal.groupBy({ by: ["userId"], where: { isArchived: false, userId: { not: null } }, _count: { _all: true }, orderBy: { _count: { userId: "desc" } }, take: 6 });
  const allUsersOwn = await prisma.meal.groupBy({ by: ["userId"], where: { isArchived: false, userId: { not: null } }, _count: { _all: true } });
  const counts = allUsersOwn.map((g) => g._count._all).sort((a, b) => a - b);
  console.log("users with >=1 own meal:", counts.length, "median own meals:", counts[Math.floor(counts.length / 2)], "users with >60:", counts.filter((c) => c > 60).length);

  // top-rated block (same as server)
  const trRows = await prisma.meal.findMany({ where: everyday, select: { id: true, title: true, saveCount: true, useCount: true } });
  const topRated = trRows.map((m) => ({ m, s: m.saveCount * 1 + m.useCount * 2 })).sort((a, b) => b.s - a.s || a.m.title.localeCompare(b.m.title)).slice(0, displayCount).map((r) => r.m);
  console.log("top_rated block size:", topRated.length, "nonzero scores:", trRows.filter((m) => m.saveCount + m.useCount > 0).length);

  for (const g of grouped) {
    const uid = g.userId!;
    const own = await prisma.meal.findMany({ where: { userId: uid, isArchived: false }, select: { id: true, title: true, sourceStoreMealId: true, _count: { select: { planItems: true } } }, orderBy: [{ title: "asc" }, { id: "asc" }] });
    const distinct = new Set(own.map((m) => norm(m.title))).size;
    const inPlans = own.filter((m) => m._count.planItems > 0).length;
    const seen = new Set<string>(); const merged: { id: string; title: string; from: string }[] = [];
    for (const m of own) if (!seen.has(m.id)) { seen.add(m.id); merged.push({ id: m.id, title: m.title, from: "own" }); }
    for (const m of topRated) if (!seen.has(m.id)) { seen.add(m.id); merged.push({ id: m.id, title: m.title, from: "top" }); }
    const page = merged.slice(0, 60);
    const fromTop = page.filter((p) => p.from === "top").length;
    const uniq = new Set(page.map((p) => norm(p.title))).size;
    console.log(JSON.stringify({ user: uid.slice(0, 8), own: own.length, ownDistinctTitles: distinct, ownInPlans: inPlans, page60_fromTopRated: fromTop, page60_uniqueTitles: uniq, firstTitle: page[0]?.title, lastTitle: page[page.length - 1]?.title }));
  }

  // what the catalog holds for Chicken Parmesan / Chicken & Dumplings neighbours
  const probes = ["piccata", "meatball", "cutlet", "parm", "chicken finger", "tender", "pot pie", "chicken soup", "stew", "chili", "dumpling"];
  const found: Record<string, number> = {};
  for (const p of probes) found[p] = await prisma.meal.count({ where: { ...everyday, title: { contains: p, mode: "insensitive" } } });
  console.log("catalog title hits:", JSON.stringify(found));

  // catalog duplicate titles
  const titles = await prisma.meal.findMany({ where: everyday, select: { title: true } });
  const tc = new Map<string, number>(); for (const t of titles) tc.set(norm(t.title), (tc.get(norm(t.title)) ?? 0) + 1);
  const dups = [...tc.entries()].filter(([, n]) => n > 1);
  console.log("catalog normalized-title dup groups:", dups.length, "rows in dups:", dups.reduce((a, [, n]) => a + n, 0), "examples:", JSON.stringify(dups.slice(0, 5)));

  // tags vocabulary on catalog
  const tagCount = new Map<string, number>();
  for (const m of await prisma.meal.findMany({ where: everyday, select: { tags: true }, take: 3000 })) for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  console.log("catalog distinct tags:", tagCount.size, "top:", JSON.stringify([...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)));

  console.log("find_similar active:", JSON.stringify(await activeVersion("meals.find_similar")));
  console.log("find_similar last30:", JSON.stringify(await llmByVersion("meals.find_similar", since30)));

  // ── BUG-041 ──────────────────────────────────────────────────────────
  console.log("=== BUG-041");
  for (const k of ["wizard.directed.parse_intent", "wizard.directed.generate"]) {
    console.log(k, "active:", JSON.stringify(await activeVersion(k)));
    console.log(k, "last30:", JSON.stringify(await llmByVersion(k, since30)));
  }
  const fleet = await prisma.lLMCallLog.groupBy({ by: ["success"], where: { createdAt: { gte: since30 } }, _count: { _all: true } });
  console.log("fleet last30:", JSON.stringify(fleet));

  // ── BUG-245 ──────────────────────────────────────────────────────────
  console.log("=== BUG-245");
  const viol: { src: string; n: bigint; viol069: bigint; nullActive: bigint }[] = await prisma.$queryRaw`
    WITH ms AS (
      SELECT m.id, m."sourceType"::text AS src, m."estimatedTimeMinutes" AS est, m."activeTimeMinutes" AS act,
             (SELECT max(s."estimatedMinutes") FROM meal_dish_links l JOIN recipe_instruction_steps s ON s."ownerType"='dish' AND s."ownerId"=l."dishId" WHERE l."mealId"=m.id) AS maxstep
      FROM meals m WHERE m."createdAt" >= ${since30}
    )
    SELECT src, count(*) AS n, count(*) FILTER (WHERE maxstep IS NOT NULL AND est < maxstep) AS viol069,
           count(*) FILTER (WHERE act IS NULL) AS "nullActive"
    FROM ms GROUP BY src ORDER BY n DESC`;
  console.log("meals created last30, by source (BUG-069 rule est<maxStep):", JSON.stringify(viol, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  const allViol: { n: bigint; viol: bigint }[] = await prisma.$queryRaw`
    SELECT count(*) AS n, count(*) FILTER (WHERE est < maxstep) AS viol FROM (
      SELECT m."estimatedTimeMinutes" AS est,
        (SELECT max(s."estimatedMinutes") FROM meal_dish_links l JOIN recipe_instruction_steps s ON s."ownerType"='dish' AND s."ownerId"=l."dishId" WHERE l."mealId"=m.id) AS maxstep
      FROM meals m WHERE m."isArchived"=false) x WHERE maxstep IS NOT NULL`;
  console.log("all unarchived meals w/ steps (BUG-069 rule):", JSON.stringify(allViol, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  const ex: unknown[] = await prisma.$queryRaw`
    SELECT m.title, m."sourceType"::text AS src, m."estimatedTimeMinutes" AS est, m."createdAt"::date AS d,
      (SELECT max(s."estimatedMinutes") FROM meal_dish_links l JOIN recipe_instruction_steps s ON s."ownerType"='dish' AND s."ownerId"=l."dishId" WHERE l."mealId"=m.id) AS maxstep
    FROM meals m WHERE m."isArchived"=false AND m."estimatedTimeMinutes" < (SELECT max(s."estimatedMinutes") FROM meal_dish_links l JOIN recipe_instruction_steps s ON s."ownerType"='dish' AND s."ownerId"=l."dishId" WHERE l."mealId"=m.id)
    ORDER BY m."createdAt" DESC LIMIT 8`;
  console.log("violators (newest):", JSON.stringify(ex));
  console.log("candidate.expand active:", JSON.stringify(await activeVersion("wizard.candidate.expand")));

  // ── BUG-275 ──────────────────────────────────────────────────────────
  console.log("=== BUG-275");
  console.log("cook_meal rows:", await prisma.userActivity.count({ where: { eventType: "cook_meal" } }));
  const ev = await prisma.userActivity.groupBy({ by: ["eventType"], where: { createdAt: { gte: since30 } }, _count: { _all: true } });
  console.log("activity types last30:", JSON.stringify(ev.map((e) => [e.eventType, e._count._all])));

  // ── BUG-301 ──────────────────────────────────────────────────────────
  console.log("=== BUG-301");
  const day = await prisma.lLMCallLog.findMany({
    where: { promptKey: "meal_builder.mode_a_parse", createdAt: { gte: new Date("2026-09-19T00:00:00Z"), lt: new Date("2026-09-21T00:00:00Z") } },
    select: { createdAt: true, success: true, retryCount: true, failureReason: true, latencyMs: true, outputTokens: true, promptVersion: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("mode_a_parse 09-19..20:", day.length, JSON.stringify(day.filter((d) => !d.success || d.retryCount > 0)));
  console.log("mode_a_parse active:", JSON.stringify(await activeVersion("meal_builder.mode_a_parse")));
  console.log("mode_a_parse last30:", JSON.stringify(await llmByVersion("meal_builder.mode_a_parse", since30)));
  const sinceAll = new Date("2026-09-15T00:00:00Z");
  console.log("mode_a_parse since 09-15:", JSON.stringify(await llmByVersion("meal_builder.mode_a_parse", sinceAll)));
  const pizzas = await prisma.meal.findMany({
    where: { title: { contains: "pizza", mode: "insensitive" }, userId: { not: null }, createdAt: { gte: new Date("2026-09-19T00:00:00Z") } },
    select: { title: true, sourceType: true, createdAt: true, dishLinks: { select: { dish: { select: { title: true, dishIngredients: { select: { ingredient: { select: { displayName: true } } } } } } } } },
    orderBy: { createdAt: "asc" }, take: 10,
  });
  for (const p of pizzas) console.log(JSON.stringify({ t: p.title, src: p.sourceType, at: p.createdAt.toISOString().slice(0, 16), dishes: p.dishLinks.map((l) => `${l.dish.title}: ${l.dish.dishIngredients.map((i) => i.ingredient.displayName).join(", ")}`) }));
}

main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 500)); process.exit(1); }).finally(() => prisma.$disconnect());
