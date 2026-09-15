// WS9 BUG-270 Phase E §3.1 — RE-TAG the 15 bought-window dishes with the 1c Encoding-B tagger, feeding it
// BASE + DEFAULT-path steps only (the shipped selectDefaultPathSteps — no second filter). Same model and
// prompt as 1c (tagger_b_prompt.ts, byte-identical). Derivation: the SHIPPED src/lib/parallelGroupDerive.ts.
// READ-ONLY against the DB; spends real tokens. Output: scripts/output/ws9-bug270/retag_tags.json.
//   node --env-file=.env --import tsx scripts/ws9-bug270/retag.ts
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

import { ADJACENCY_MAX_MINUTES, deriveParallelGroups } from "../../src/lib/parallelGroupDerive";
import { deriveMealTiming } from "../../src/lib/mealTiming";
import { selectDefaultPathSteps, type SchedulerDish } from "../../src/lib/cookingScheduler";
import { costUsd, isUn, loadMeals, windowsToSteps, type DishRow, type RawWindows, type Usage } from "../ws9-239/common.js";
import { TAGGER_B_INSTRUCTIONS, TOOL } from "../ws9-239/tagger_b_prompt.js";

const OUT = "scripts/output/ws9-bug270";
const MODEL = "claude-sonnet-4-6"; // 1c's model
const DISH_IDS = "13768b3e-fc56-43cf-9375-8e30f0cd169e 1dbd7b60-0e5c-439f-b00b-61652f5bd77d 2dccf8f5-c6b5-44e3-be1b-cbdb9d841ee7 75c71b4f-ab3a-4464-90fb-7c389c508642 7969ed9e-857d-4ed7-8eb1-100bcd7386cb 7d58167f-dbd6-4820-9ce8-4ae94c7b7a33 8ff4fcab-a231-4ea4-a9f4-b5cff5e1bb49 9742d019-3490-44e7-8509-cc9570d016ec 9b058246-246c-45db-a27c-e31869449b91 a3d24d3a-02cb-4921-b33a-02fa829d840a b4521181-28f9-4918-bfb9-19c74da208bd bac3389a-c743-460e-9a5f-8bef58c7a245 cbc01879-4f5f-4b1a-972e-bc73e5094ac1 cd718db6-cbbf-40c9-8b3a-511185a8ccc1 df3e5704-7052-49ef-b004-05802ec0361a".split(" ");

console.log(`derivation module: src/lib/parallelGroupDerive.ts · ADJACENCY_MAX_MINUTES=${ADJACENCY_MAX_MINUTES} · step filter: src/lib/cookingScheduler.ts selectDefaultPathSteps · prompt: scripts/ws9-239/tagger_b_prompt.ts (1c, byte-identical) · model ${MODEL}`);
const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host} · DB writes: NONE`);
const links = await prisma.mealDishLink.findMany({ where: { dishId: { in: DISH_IDS } }, select: { mealId: true, dishId: true } });
const mealIds = [...new Set(links.map((l) => l.mealId))];
const meals = await loadMeals(prisma, mealIds);
// current tags (loadMeals does not select parallelGroup)
const curTags = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: DISH_IDS } }, select: { ownerId: true, stepIndex: true, parallelGroup: true } });
const tagOf = (dishId: string, stepIndex: number) => curTags.find((t) => t.ownerId === dishId && t.stepIndex === stepIndex)?.parallelGroup ?? null;
console.log(`dishes: ${DISH_IDS.length} · meals: ${mealIds.length} (loaded ${meals.length})`);

const client = new Anthropic(); // ANTHROPIC_API_KEY from .env; never printed
type Result = { mealId: string; dishId: string; title: string; filteredStepIndexes: number[]; raw: RawWindows | null; tags: Record<number, string>; issues: { cls: string; detail: string }[]; tieBreaks: number; declaredCount: number; usd: number; ms: number; oldTags: Record<number, string>; predicted: { total: number | null; active: number | null; dish: number | undefined }; current: { total: number; active: number | null; dish: number | null } };
const results: Result[] = [];
let spent = 0;
for (const m of meals) {
  for (const d of m.dishes) {
    if (!DISH_IDS.includes(d.dishId)) continue;
    // BASE + DEFAULT path only, stored stepIndex preserved.
    const filtered: DishRow = { ...d, steps: selectDefaultPathSteps(d.steps) };
    const input = { dishTitle: d.title, steps: filtered.steps.map((s) => ({ stepIndex: s.stepIndex, text: s.text, phaseType: s.phaseType, estimatedMinutes: s.estimatedMinutes, isTimingSensitive: s.isTimingSensitive, componentKey: s.componentKey ?? null, pathKey: s.pathKey ?? null })) };
    const t = Date.now();
    const res = await client.messages.create({ model: MODEL, max_tokens: 2048, temperature: 0, system: [{ type: "text", text: TAGGER_B_INSTRUCTIONS, cache_control: { type: "ephemeral" } }], tools: [TOOL], tool_choice: { type: "tool", name: "tag_windows" }, messages: [{ role: "user", content: JSON.stringify(input) }] });
    const ms = Date.now() - t;
    const u: Usage = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
    const usd = costUsd(u, MODEL); spent += usd;
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = (tu?.input as RawWindows | undefined) ?? null;
    const { steps, boundaryIssues } = windowsToSteps(filtered, raw);
    const der = raw ? deriveParallelGroups(steps) : { tags: filtered.steps.map(() => null), issues: [{ cls: "no_tool_use", detail: `stop_reason=${res.stop_reason}` }], tieBreaks: 0, declaredCount: 0 };
    const tags: Record<number, string> = {};
    der.tags.forEach((tok, i) => { if (tok !== null) tags[filtered.steps[i].stepIndex] = tok; });
    const oldTags: Record<number, string> = {};
    for (const s of d.steps) { const ot = tagOf(d.dishId, s.stepIndex); if (ot) oldTags[s.stepIndex] = ot; }
    // predict: this meal with THIS dish's tags replaced by the new set, every other dish's tags as stored
    const dishes: SchedulerDish[] = m.dishes.map((x) => ({ dishId: x.dishId, title: x.title, positionIndex: x.positionIndex, steps: x.steps.map((s) => ({ stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, isTimingSensitive: s.isTimingSensitive, componentKey: s.componentKey ?? null, pathKey: s.pathKey ?? null, parallelGroup: x.dishId === d.dishId ? (tags[s.stepIndex] ?? null) : tagOf(x.dishId, s.stepIndex) })) }));
    const pt = deriveMealTiming(dishes);
    const curDish = await prisma.dish.findUnique({ where: { id: d.dishId }, select: { estimatedTimeMinutes: true } });
    results.push({ mealId: m.id, dishId: d.dishId, title: d.title, filteredStepIndexes: filtered.steps.map((s) => s.stepIndex), raw, tags, issues: [...boundaryIssues, ...der.issues], tieBreaks: der.tieBreaks, declaredCount: der.declaredCount, usd, ms, oldTags, predicted: { total: pt.totalMinutes, active: pt.activeMinutes, dish: pt.dishTotals.get(d.dishId) }, current: { total: m.estimatedTimeMinutes, active: m.activeTimeMinutes, dish: curDish?.estimatedTimeMinutes ?? null } });
    // hand-check print: every step (bought marked), old tag, new tag
    console.log(`\n== ${d.dishId.slice(0, 8)} "${d.title}"  meal "${m.title.slice(0, 50)}"  current meal ${m.estimatedTimeMinutes}/${m.activeTimeMinutes}a dish ${curDish?.estimatedTimeMinutes} → predicted meal ${pt.totalMinutes}/${pt.activeMinutes}a dish ${pt.dishTotals.get(d.dishId)}  $${usd.toFixed(4)} ${ms}ms  issues=[${[...boundaryIssues, ...der.issues].map((i) => i.cls)}] declared=${der.declaredCount}`);
    for (const s of d.steps) {
      const b = s.pathKey === "bought";
      console.log(`   ${b ? "DROP" : "    "} #${String(s.stepIndex).padStart(2)} ${String(s.estimatedMinutes).padStart(3)}m ${s.phaseType.padEnd(8)} ${isUn(s) ? "UN" : "at"} old=${(oldTags[s.stepIndex] ?? "-").padEnd(3)} new=${(b ? "·" : tags[s.stepIndex] ?? "-").padEnd(3)} ${(s.componentKey ?? "-").padEnd(12)} ${(s.pathKey ?? "base").padEnd(7)} ${s.text.slice(0, 84)}`);
    }
    if (raw) console.log(`   raw windows: ${raw.windows.map((w) => `#${w.stepIndex}→${w.firstDependent === null ? "null" : "#" + w.firstDependent}`).join("  ")}`);
  }
}
writeFileSync(`${OUT}/retag_tags.json`, JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, derivation: "src/lib/parallelGroupDerive.ts", adjacencyMaxMinutes: ADJACENCY_MAX_MINUTES, stepFilter: "selectDefaultPathSteps", spentUsd: spent, results }, null, 1));
console.log(`\ndishes tagged: ${results.length} · spent $${spent.toFixed(4)} · wrote ${OUT}/retag_tags.json · DB writes: NONE`);
await prisma.$disconnect();
