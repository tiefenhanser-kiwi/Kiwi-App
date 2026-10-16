// CAT-Q1 — the limits, the gate, the stamp call, the revert, Part B's rules and
// the sous vide table. No database, no AI: the transactional paths run against
// an in-memory fake of the Prisma calls they make.
//
//   node --import tsx --test scripts/_scratch/cat-q1/catq1.test.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { Prisma } from "@prisma/client";

import { selectDefaultPathSteps } from "../../../src/lib/cookingScheduler";
import type { CatDish, CatMeal } from "../cat-q0/catalogDb";
import type { ReviewIssue } from "../cat-q0/rubric";
import { applyEdits, applyPatch, patchMeal, StaleEdit, type ApplyDeps, type Edit, type IngRow } from "./edits";
import { editorPayload, type PatchInput } from "./editor";
import { reviewGate, roundTwoDeclined, sameIssue, secondRoundIssues, wantsSecondRound } from "./gate";
import { graphHash, readGraph, restoreGraph, reviveGraph } from "./graph";
import { parseWhere, type Q0Issue } from "./issues";
import { checkPatch, vesselsIn } from "./limits";
import { partBEdits } from "./partB";
import { fixProse } from "./prose";
import { checkSousVide, formatMinutes, sousVideFailures, tableMinutes } from "./sousVide";

// ── a small meal ────────────────────────────────────────────────────────────
const MEAL = "meal-1", DISH = "dish-1";
const ING = { chicken: "ing-chicken", garlic: "ing-garlic", oil: "ing-oil", lemon: "ing-lemon" };
function meal(): CatMeal {
  const ingredients: CatDish["ingredients"] = [
    { id: "di-1", ingredientId: ING.chicken, name: "chicken thighs", canonicalName: "chicken thighs", aliases: [], quantity: 1.5, unit: "pound", preparationNote: null, isOptional: false, componentKey: null, pathKey: null, fromLeftovers: false },
    { id: "di-2", ingredientId: ING.garlic, name: "garlic", canonicalName: "garlic", aliases: [], quantity: 4, unit: "each", preparationNote: "minced", isOptional: false, componentKey: null, pathKey: null, fromLeftovers: false },
    { id: "di-3", ingredientId: ING.oil, name: "olive oil", canonicalName: "olive oil", aliases: [], quantity: 0.38, unit: "cup", preparationNote: null, isOptional: false, componentKey: null, pathKey: null, fromLeftovers: false },
  ];
  const step = (i: number, text: string, minutes: number, phaseType = "cook") => ({ id: `st-${i}`, stepIndex: i, text, phaseType, estimatedMinutes: minutes, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null, amountRefs: [] });
  const allSteps = [
    step(0, "Pat the chicken thighs dry, rub with the garlic and 0.5 cup olive oil.", 5, "prep"),
    step(1, "Grill the chicken 6 minutes per side until cooked through.", 12),
    step(2, "Serve with lemon wedges.", 1, "assemble"),
  ];
  return {
    id: MEAL, title: "Grilled Chicken", displayTitle: null, mealType: "dinner", sourceType: "batch_generated", dishFamilyKey: null, userId: null, tags: [],
    servingsDefault: 4, estimatedTimeMinutes: 18, activeTimeMinutes: 18, allergens: [], updatedAt: new Date("2026-10-01T00:00:00Z"),
    dishes: [{ dishId: DISH, positionIndex: 0, role: "main", title: "Grilled Chicken", servingsDefault: 4, substitutions: [], ingredients, allSteps, steps: selectDefaultPathSteps(allSteps) }],
    derived: { totalMinutes: 18, activeMinutes: 18 },
  };
}
const issue = (n: number, o: Partial<Q0Issue>): Q0Issue => ({ n, mealId: MEAL, title: "Grilled Chicken", verdict: "fix", featured: "", class: 5, severity: "fix", dish: "Grilled Chicken", where: "", quote: "", why: "", fix: "", ingredient: null, stepIndex: null, ...o });
const ISSUES: Q0Issue[] = [
  issue(1, { class: 5, stepIndex: 1, where: "step 1", quote: "until cooked through", why: "No 165°F check for poultry.", fix: "Add: until the thickest part reads 165°F." }),
  issue(2, { class: 2, stepIndex: 2, where: "step 2", quote: "Serve with lemon wedges.", why: "No lemon is listed.", fix: "Add 1 lemon to the ingredients." }),
];
const LEMON: IngRow = { id: ING.lemon, displayName: "lemon", canonicalName: "lemon", aliases: [] };

function plan(m: CatMeal, input: Partial<PatchInput>, resolved = new Map<string, IngRow | null>([["lemon", LEMON]])) {
  const { ids, json } = editorPayload(m, ISSUES.map((i) => ({ ...i })));
  const printed = new Map<string, string>();
  for (const d of (json as { meal: { dishes: Array<{ ingredients: Array<{ id: string; printed: string }> }> } }).meal.dishes) for (const i of d.ingredients) printed.set(ids.line.get(i.id)!.rowId, i.printed);
  const sid = (k: number) => [...ids.step.entries()].find(([, v]) => v.rowId === `st-${k}`)![0];
  const full: PatchInput = { step_edits: [], line_edits: [], new_lines: [], declined: [], ...input };
  return { r: checkPatch(m, full, ids, ISSUES, resolved, printed), sid };
}
const sid = (k: number) => `s${k + 1}`;
const S1 = "Grill the chicken 6 minutes per side until cooked through.";
const S1_FIX = "Brush with 2 tablespoons olive oil and grill 6 minutes per side, until an instant-read thermometer in the thickest part reads 165°F.";

describe("limits (code, not the model)", () => {
  it("accepts an edit to the step its issue names", () => {
    const { r } = plan(meal(), { step_edits: [{ step_id: sid(1), old_text: S1, new_text: S1_FIX, old_minutes: 12, new_minutes: 12, answers: [1] }], declined: [{ issue: 2, reason: "x" }] });
    assert.deepEqual(r.rejections, []);
    assert.equal(r.edits.length, 1);
  });
  it("rejects a patch touching a step no issue it answers names and that shares no vessel or ingredient with one", () => {
    // step 2 ("Serve with lemon wedges.") shares nothing with step 1, the step issue 1 names
    const { r } = plan(meal(), {
      step_edits: [
        { step_id: sid(1), old_text: S1, new_text: S1_FIX, old_minutes: 12, new_minutes: 12, answers: [1] },
        { step_id: sid(2), old_text: "Serve with lemon wedges.", new_text: "Serve at once with lemon wedges.", old_minutes: 1, new_minutes: 1, answers: [1] },
      ],
    });
    assert.equal(r.edits.length, 0, "the whole patch is rejected");
    assert.ok(r.rejections.some((x) => /step 2 .*shares no vessel or ingredient/.test(x)), r.rejections.join("\n"));
  });
  it("a step sharing an ingredient with the named step is coupled (chicken thighs)", () => {
    const m = meal();
    const s0 = m.dishes[0].steps[0].text;
    const { r } = plan(m, {
      step_edits: [
        { step_id: sid(1), old_text: S1, new_text: S1_FIX, old_minutes: 12, new_minutes: 12, answers: [1] },
        { step_id: sid(0), old_text: s0, new_text: s0.replace("Pat", "Gently pat"), old_minutes: 5, new_minutes: 5, answers: [1] },
      ],
      declined: [{ issue: 2, reason: "x" }],
    });
    assert.deepEqual(r.rejections, []);
    assert.ok(r.notes.some((n) => /step 0 .*coupled — shares an ingredient/.test(n)));
  });
  it("rejects an `old` that is not the stored text", () => {
    const { r } = plan(meal(), { step_edits: [{ step_id: sid(1), old_text: "Grill the chicken.", new_text: S1_FIX, old_minutes: 12, new_minutes: 12, answers: [1] }] });
    assert.ok(r.rejections.some((x) => /old text is not the stored text/.test(x)));
  });
  it("rejects a fraction glyph or a string in a numeric quantity (THX-2G)", () => {
    for (const q of ["½", "0.5", Number.NaN] as unknown[]) {
      const { r } = plan(meal(), { new_lines: [{ dish: "Grilled Chicken", line: { quantity: q as number, unit: "each", name: "lemon", note: "cut into wedges", optional: false }, answers: [2] }] });
      assert.ok(r.rejections.some((x) => /is not a plain number/.test(x)), `${String(q)}: ${r.rejections.join("|")}`);
    }
  });
  it("accepts a new line a step uses, resolved to an EXISTING ingredient; refuses one that would need a new row", () => {
    const ok = plan(meal(), { new_lines: [{ dish: "Grilled Chicken", line: { quantity: 1, unit: "each", name: "lemon", note: "cut into wedges", optional: false }, answers: [2] }] }).r;
    assert.deepEqual(ok.rejections, []);
    assert.equal(ok.edits[0].kind, "new_ingredient");
    const miss = plan(meal(), { new_lines: [{ dish: "Grilled Chicken", line: { quantity: 1, unit: "each", name: "lemon", note: null, optional: false }, answers: [2] }] }, new Map([["lemon", null]])).r;
    assert.ok(miss.rejections.some((x) => /never created/.test(x)));
  });
  it("rejects ⅜ of a cup, an off-catalog unit, and a decimal written into step text", () => {
    const m = meal();
    const s0 = m.dishes[0].steps[0].text;
    const r1 = plan(m, { new_lines: [{ dish: "Grilled Chicken", line: { quantity: 0.4, unit: "each", name: "lemon", note: null, optional: false }, answers: [2] }] }).r;
    assert.ok(r1.rejections.some((x) => /not a cook's fraction/.test(x)));
    const r2 = plan(m, { new_lines: [{ dish: "Grilled Chicken", line: { quantity: 1, unit: "wedge", name: "lemon", note: null, optional: false }, answers: [2] }] }).r;
    assert.ok(r2.rejections.some((x) => /not a catalog unit/.test(x)));
    const r3 = plan(m, { step_edits: [{ step_id: sid(1), old_text: S1, new_text: `${S1_FIX} Brush with 0.25 cup oil.`, old_minutes: 12, new_minutes: 12, answers: [1] }] }).r;
    assert.ok(r3.rejections.some((x) => /0\.25 cup/.test(x)), r3.rejections.join("|"));
    assert.ok(!plan(m, { step_edits: [{ step_id: sid(0), old_text: s0, new_text: s0, old_minutes: 5, new_minutes: 5, answers: [1] }] }).r.rejections.some((x) => /0\.5 cup/.test(x)), "a decimal already there is not the edit's");
  });
  it("a third may arrive as 0.3333 and is stored as exactly 1/3", () => {
    const { r } = plan(meal(), { new_lines: [{ dish: "Grilled Chicken", line: { quantity: 0.3333, unit: "cup", name: "lemon", note: null, optional: false }, answers: [2] }] });
    assert.deepEqual(r.rejections, []);
    assert.equal((r.edits[0] as Extract<Edit, { kind: "new_ingredient" }>).new.quantity, 1 / 3);
  });
});

// ── the fake transaction ────────────────────────────────────────────────────
type Row = Record<string, unknown>;
function match(r: Row, w: Row | undefined): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((x) => match(r, x));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as Row;
      if ("in" in o) return (o.in as unknown[]).includes(r[k]);
      if ("not" in o) return r[k] !== o.not;
    }
    return r[k] === v;
  });
}
function fakeTx(tables: Record<string, Row[]>) {
  const val = (v: unknown) => (v === Prisma.DbNull ? null : v);
  const model = (name: string) => ({
    findUnique: async ({ where }: { where: Row }) => { const r = tables[name].find((x) => match(x, where)); return r ? { ...r } : null; },
    findMany: async ({ where, include }: { where?: Row; include?: Row } = {}) =>
      tables[name].filter((x) => match(x, where)).sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((x) => (include?.ingredient ? { ...x, ingredient: { ...tables.ingredient.find((i) => i.id === x.ingredientId) } } : { ...x })),
    update: async ({ where, data }: { where: Row; data: Row }) => { const r = tables[name].find((x) => match(x, where))!; for (const [k, v] of Object.entries(data)) r[k] = val(v); return { ...r }; },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => { const rs = tables[name].filter((x) => match(x, where)); for (const r of rs) Object.assign(r, data); return { count: rs.length }; },
    create: async ({ data }: { data: Row }) => { const r: Row = { id: randomUUID(), ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, val(v)])) }; tables[name].push(r); return { ...r }; },
    delete: async ({ where }: { where: Row }) => { const i = tables[name].findIndex((x) => match(x, where)); return tables[name].splice(i, 1)[0]; },
    aggregate: async ({ where }: { where: Row }) => ({ _max: { positionIndex: Math.max(-1, ...tables[name].filter((x) => match(x, where)).map((x) => x.positionIndex as number)) } }),
  });
  return { meal: model("meal"), mealDishLink: model("mealDishLink"), dish: model("dish"), dishIngredient: model("dishIngredient"), recipeInstructionStep: model("recipeInstructionStep"), ingredient: model("ingredient") } as unknown as Prisma.TransactionClient;
}
function db() {
  const m = meal();
  const d = m.dishes[0];
  return {
    meal: [{ id: MEAL, title: m.title, isArchived: false, allergens: [], allergenSources: null, allergensStampedAt: new Date("2026-10-01T00:00:00Z"), estimatedTimeMinutes: 18, activeTimeMinutes: 18, updatedAt: new Date("2026-10-02T00:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z") }],
    mealDishLink: [{ id: "link-1", mealId: MEAL, dishId: DISH, positionIndex: 0, roleLabel: "main" }],
    dish: [{ id: DISH, title: d.title, substitutions: null, componentRegistry: null, estimatedTimeMinutes: 18, updatedAt: new Date("2026-10-02T00:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z") }],
    dishIngredient: d.ingredients.map((i, k) => ({ id: i.id!, dishId: DISH, ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit, preparationNote: i.preparationNote, isOptional: i.isOptional, positionIndex: k, componentKey: null, pathKey: null, fromLeftovers: false })),
    recipeInstructionStep: d.allSteps.map((s) => ({ id: s.id!, ownerType: "dish", ownerId: DISH, stepIndex: s.stepIndex, stepTextRaw: s.text, stepTextTranslated: s.text, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, amountRefs: [], componentKey: null, pathKey: null })),
    ingredient: [
      { id: ING.chicken, displayName: "chicken thighs" }, { id: ING.garlic, displayName: "garlic" }, { id: ING.oil, displayName: "olive oil" }, { id: ING.lemon, displayName: "lemon" },
    ],
  } as Record<string, Row[]>;
}
const stepEdit = (oldText: string): Edit => ({ source: "C", kind: "step", dishId: DISH, dishTitle: "Grilled Chicken", answers: [1], stepId: "st-1", stepIndex: 1, old: { text: oldText, minutes: 12 }, new: { text: S1_FIX, minutes: 12 } });
const lemonLine: Edit = { source: "C", kind: "new_ingredient", dishId: DISH, dishTitle: "Grilled Chicken", answers: [2], old: null, new: { quantity: 1, unit: "each", name: "lemon", preparationNote: "cut into wedges", isOptional: false }, ingredient: LEMON };
function spyDeps() {
  const calls: string[] = [];
  const deps: ApplyDeps = { stamp: async (_tx, id) => { calls.push(`stamp ${id}`); }, timing: async (_tx, id, ds) => { calls.push(`timing ${id} ${ds.join(",")}`); } };
  return { calls, deps };
}

describe("apply (one meal, inside the caller's transaction)", () => {
  it("writes the edits, re-derives the edited step's amountRefs, then stamps allergens and timing", async () => {
    const t = db();
    const { calls, deps } = spyDeps();
    const r = await applyEdits(fakeTx(t), MEAL, [stepEdit(S1), lemonLine], deps);
    assert.equal(r.applied, 2);
    assert.equal(t.recipeInstructionStep.find((s) => s.id === "st-1")!.stepTextRaw, S1_FIX);
    assert.equal(t.recipeInstructionStep.find((s) => s.id === "st-1")!.stepTextTranslated, S1_FIX);
    // the materializer's derivation, re-run on the new text: "2 tablespoons olive oil" → the oil line
    assert.deepEqual((t.recipeInstructionStep.find((s) => s.id === "st-1")!.amountRefs as Array<{ ingredientId: string }>).map((x) => x.ingredientId), [ING.oil]);
    assert.ok(t.dishIngredient.some((l) => l.ingredientId === ING.lemon && l.positionIndex === 3));
    assert.deepEqual(calls, [`stamp ${MEAL}`, `timing ${MEAL} ${DISH}`]);
  });
  it("skips a meal whose stored value no longer equals `old`: nothing written, nothing stamped", async () => {
    const t = db();
    t.recipeInstructionStep.find((s) => s.id === "st-1")!.stepTextRaw = "Someone edited this step.";
    const before = JSON.stringify(t);
    const { calls, deps } = spyDeps();
    await assert.rejects(applyEdits(fakeTx(t), MEAL, [lemonLine, stepEdit(S1)], deps), (e) => e instanceof StaleEdit && /no longer equals old/.test(e.message));
    assert.equal(JSON.stringify(t), before, "the lemon line before it was not written either");
    assert.deepEqual(calls, []);
  });
  it("Part B edits are idempotent inside a C patch (already applied → skipped, not stale)", async () => {
    const t = db();
    const garlic = partBEdits(meal()).edits.find((e) => e.rule === "garlic_clove")!;
    const { deps } = spyDeps();
    assert.equal((await applyEdits(fakeTx(t), MEAL, [garlic], deps)).applied, 1);
    const again = await applyEdits(fakeTx(t), MEAL, [garlic], deps);
    assert.deepEqual(again, { applied: 0, already: 1 });
  });
  it("refuses a dish another meal also links", async () => {
    const t = db();
    t.mealDishLink.push({ id: "link-2", mealId: "meal-2", dishId: DISH, positionIndex: 0, roleLabel: "main" });
    await assert.rejects(applyEdits(fakeTx(t), MEAL, [stepEdit(S1)], spyDeps().deps), /also linked by meal meal-2/);
  });
});

describe("revert", () => {
  it("restores the pre-image byte for byte (hash) after an apply, through a JSON round trip", async () => {
    const t = db();
    const tx = fakeTx(t);
    const pre = (await readGraph(tx, MEAL))!;
    const preHash = graphHash(pre);
    const saved = JSON.parse(JSON.stringify(pre));
    await applyEdits(tx, MEAL, [stepEdit(S1), lemonLine, ...partBEdits(meal()).edits], spyDeps().deps);
    t.meal[0].updatedAt = new Date(); // what Prisma's @updatedAt would do
    assert.notEqual(graphHash(await readGraph(tx, MEAL)), preHash);
    const n = await restoreGraph(tx, reviveGraph(saved), Prisma.DbNull);
    assert.equal(graphHash(await readGraph(tx, MEAL)), preHash);
    assert.ok(n.deleted >= 1, "the added lemon line is deleted");
  });
});

describe("the gate", () => {
  const ri = (o: Partial<ReviewIssue>): ReviewIssue => ({ class: 5, severity: "fix", dish: "Grilled Chicken", ingredient: null, stepIndex: null, quote: "", why: "", fix: "", ...o });
  const base = { patched: meal(), issues: ISSUES, answered: new Set([1]), baseline: [] as ReviewIssue[] };
  it("passes when the answered issue is gone and only an unanswered one is left", () => {
    const g = reviewGate({ ...base, after: { verdict: "fix", issues: [ri({ class: 2, stepIndex: 2, quote: "Serve with lemon wedges." }), ri({ class: 3, severity: "polish", quote: "x" })] } });
    assert.ok(g.ok, g.reasons.join("|"));
    assert.equal(g.allowed.length, 1);
  });
  it("rejects when the answered issue is still there", () => {
    const g = reviewGate({ ...base, after: { verdict: "fix", issues: [ri({ stepIndex: 1, quote: "per side until cooked" })] } });
    assert.ok(!g.ok && /answered issue 1 is still there/.test(g.reasons[0]));
  });
  it("rejects a new block or fix", () => {
    const g = reviewGate({ ...base, after: { verdict: "block", issues: [ri({ class: 1, severity: "block", stepIndex: 0, quote: "rub with the garlic" })] } });
    assert.ok(!g.ok && /^new block/.test(g.reasons[0]));
  });
  it("an issue the baseline review already had is not the patch's", () => {
    const old = ri({ class: 4, stepIndex: 0, quote: "Pat the chicken thighs dry" });
    assert.ok(reviewGate({ ...base, baseline: [old], after: { verdict: "fix", issues: [old] } }).ok);
  });
  it("matches the same problem across rewording: same dish, class and step", () => {
    assert.ok(sameIssue(ri({ stepIndex: 1, quote: "a" }), { ...ISSUES[0] }));
    assert.ok(!sameIssue(ri({ class: 4, stepIndex: 1 }), { ...ISSUES[0] }));
  });
  it("a sous vide doneness issue the ruling covers is set aside only once the sentence is there", () => {
    const m = meal();
    const d = m.dishes[0];
    d.allSteps[1].text = "Seal the chicken and cook sous vide at 145°F for 1 hour 30 minutes.";
    d.steps = selectDefaultPathSteps(d.allSteps);
    const r = ri({ severity: "block", stepIndex: 1, quote: "cook sous vide at 145°F for 1 hour 30 minutes" });
    const without = reviewGate({ ...base, patched: m, answered: new Set([1]), after: { verdict: "block", issues: [r] } });
    assert.ok(!without.ok);
    const withS = patchMeal(m, [{ source: "C", kind: "step", dishId: DISH, dishTitle: d.title, answers: [1], stepId: "st-1", stepIndex: 1, old: { text: d.allSteps[1].text, minutes: 12 }, new: { text: `${d.allSteps[1].text} Holding it at 145°F for the full 1 hour 30 minutes is what makes it safe to eat.`, minutes: 12 } }]);
    const g = reviewGate({ ...base, patched: withS, after: { verdict: "block", issues: [r] } });
    assert.ok(g.ok, g.reasons.join("|"));
    assert.equal(g.ruled.length, 1);
  });
});

describe("Part B", () => {
  it("garlic counted 'each' with no 'clove' becomes unit clove; the name is untouched", () => {
    const e = partBEdits(meal()).edits.find((x) => x.rule === "garlic_clove") as Extract<Edit, { kind: "ingredient" }>;
    assert.equal(e.new!.unit, "clove");
    assert.equal(e.new!.name, "garlic");
    const m = meal();
    m.dishes[0].ingredients[1].name = "garlic cloves";
    assert.ok(!partBEdits(m).edits.some((x) => x.rule === "garlic_clove"), "'4 garlic cloves' already reads right (hidden each)");
    // "4 each garlic (cloves, minced)" prints "4 garlics (cloves, minced)": unit clove, the note loses "cloves"
    const n = meal();
    n.dishes[0].ingredients[1].preparationNote = "cloves, minced";
    const ne = partBEdits(n).edits.find((x) => x.rule === "garlic_clove") as Extract<Edit, { kind: "ingredient" }>;
    assert.deepEqual([ne.new!.unit, ne.new!.preparationNote], ["clove", "minced"]);
    // "garlic bread" is bread: never cloves
    const gb = meal();
    gb.dishes[0].ingredients[1].name = "frozen garlic bread";
    gb.dishes[0].ingredients[1].quantity = 1;
    assert.ok(!partBEdits(gb).edits.some((x) => x.rule === "garlic_clove"), "1 each frozen garlic bread stays a loaf");
    // a note that COUNTS cloves means a whole head: reported, not edited
    const h = meal();
    h.dishes[0].ingredients[1].quantity = 1;
    h.dishes[0].ingredients[1].preparationNote = "about 10 cloves, peeled";
    const hb = partBEdits(h);
    assert.ok(!hb.edits.some((x) => x.rule === "garlic_clove"));
    assert.ok(hb.skips.some((s) => s.rule === "garlic_clove"));
  });
  it("a spoon/cup line printed ⅜ ⅝ ⅞ snaps to the nearest cook's fraction", () => {
    const e = partBEdits(meal()).edits.find((x) => x.rule === "spoon_eighth") as Extract<Edit, { kind: "ingredient" }>;
    assert.equal(e.new!.quantity, 1 / 3);
  });
  it("step decimals become the screen's glyphs; weights only when already a quarter, half or third", () => {
    assert.equal(fixProse("Add 0.5 cups broth and 1.25 cups water.").text, "Add ½ cup broth and 1¼ cups water.");
    assert.equal(fixProse("Pat the 0.75 lb chicken dry; add 1.5 tsp salt.").text, "Pat the ¾ lb chicken dry; add 1½ tsp salt.");
    assert.equal(fixProse("Whisk in 0.33 cup oil.").text, "Whisk in ⅓ cup oil.");
    const left = fixProse("Use 0.4 lb shrimp and a 14.5 oz can.");
    assert.equal(left.text, "Use 0.4 lb shrimp and a 14.5 oz can.", "a decimal ounce is the can's printed size");
    assert.deepEqual(left.left, ["0.4 lb"]);
    assert.equal(fixProse("Stir in ⅜ cup cream and 1⅞ teaspoons salt.").text, "Stir in ⅓ cup cream and 1¾ teaspoons salt.");
    assert.equal(fixProse("Cut into 1.5-inch pieces.").text, "Cut into 1.5-inch pieces.");
  });
  it("a self-swap is removed only when no bought-path row belongs to it", () => {
    const m = meal();
    m.dishes[0].substitutions = [{ product: "store-bought chicken broth", quantity: 2, unit: "cup", replaces: ["chicken broth"] }];
    assert.ok(partBEdits(m).edits.some((x) => x.kind === "swap_remove"));
    m.dishes[0].allSteps.push({ id: "st-9", stepIndex: 9, text: "Use the bought broth.", phaseType: "cook", estimatedMinutes: 1, isTimingSensitive: false, parallelGroup: null, componentKey: "broth", pathKey: "bought", amountRefs: [] });
    const b = partBEdits(m);
    assert.ok(!b.edits.some((x) => x.kind === "swap_remove"));
    assert.match(b.skips.find((s) => s.rule === "swap_self")!.detail, /structure change/);
  });
});

describe("sous vide under D-WS9-315 (FSIS table)", () => {
  const dish = (text: string, title = "Sous Vide Chicken Breast") => ({ title, ingredients: [], steps: [{ stepIndex: 3, text }] }) as unknown as CatDish;
  it("145°F for 1 hour 30 minutes passes: it covers 60 min come-up + 10.4 min FSIS hold", () => {
    const c = checkSousVide(dish("Submerge the bag and cook sous vide at 145°F for 1 hour 30 minutes."))!;
    assert.equal(c.bathF, 145); assert.equal(c.holdMinutes, 90); assert.equal(c.holdStep, 3);
    assert.ok(c.meets); assert.ok(c.meetsAtCore);
  });
  it("140°F for 1 hour FAILS once come-up is counted (Lemon-Oregano), and the passing time is 2 hours", () => {
    const c = checkSousVide(dish("Submerge the sealed bag in the 140°F water bath and cook for 1 hour."))!;
    assert.ok(c.meetsAtCore, "it does cover the FSIS hold alone");
    assert.ok(!c.meets);
    assert.equal(c.passingMinutes, 120);
    assert.equal(formatMinutes(c.passingMinutes!), "2 hours");
  });
  it("pork at 140°F for 1 hour 30 minutes passes the meat table (60 + 12 min)", () => {
    const c = checkSousVide(dish("Submerge the sealed bag in the 140°F water bath and cook for 1 hour 30 minutes.", "Sous Vide Italian Herb Pork Loin"))!;
    assert.equal(c.protein, "meat"); assert.ok(c.meets);
  });
  it("below the table is never safe: no passing time", () => {
    assert.equal(tableMinutes("poultry", 130), null);
    const c = checkSousVide(dish("Cook sous vide at 130°F for 2 hours."))!;
    assert.ok(!c.meets); assert.equal(c.passingMinutes, null);
  });
  it("the gate rejects a patched meal whose final sous vide time is still short", () => {
    const m = meal();
    m.dishes[0].steps = [{ ...m.dishes[0].steps[1], text: "Submerge the sealed bag in the 140°F water bath and cook for 1 hour." }];
    m.dishes[0].title = "Sous Vide Lemon-Oregano Chicken Breast";
    assert.equal(sousVideFailures(m).length, 1);
    m.dishes[0].steps[0].text = "Submerge the sealed bag in the 140°F water bath and cook for 2 hours. Holding the chicken at 140°F for the full 2 hours is what makes it safe to eat.";
    assert.deepEqual(sousVideFailures(m), []);
  });
  it("a short sous vide time with the safety sentence is NOT set aside by the gate", () => {
    const m = meal();
    const d = m.dishes[0];
    d.allSteps[1].text = "Cook sous vide at 140°F for 1 hour. Holding the chicken at 140°F for the full hour is what makes it safe to eat.";
    d.steps = selectDefaultPathSteps(d.allSteps);
    const r: ReviewIssue = { class: 5, severity: "block", dish: "Grilled Chicken", ingredient: null, stepIndex: 1, quote: "Cook sous vide at 140°F for 1 hour.", why: "", fix: "" };
    assert.ok(!reviewGate({ patched: m, issues: ISSUES, answered: new Set([1]), baseline: [], after: { verdict: "block", issues: [r] } }).ok);
  });
});

// ── follow-up B: coupled steps across dishes, the produce fold, round 2 ─────
function panMeal(): CatMeal {
  const m = meal();
  const st = (id: string, i: number, text: string) => ({ id, stepIndex: i, text, phaseType: "cook", estimatedMinutes: 5, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null, amountRefs: [] });
  const ing = (id: string, ingredientId: string, name: string, quantity: number, unit: string) => ({ id, ingredientId, name, canonicalName: name, aliases: [], quantity, unit, preparationNote: null, isOptional: false, componentKey: null, pathKey: null, fromLeftovers: false });
  const a = [st("g0", 0, "Preheat the oven to 450°F and place a large rimmed sheet pan inside to heat."), st("g1", 1, "Spread the gnocchi on half of the hot pan and roast 20 minutes."), st("g2", 2, "Toss the arugula in a bowl.")];
  const b = [st("t0", 0, "Roast the tomatoes on the other half of the sheet pan.")];
  m.dishes = [
    { dishId: "dg", positionIndex: 0, role: "main", title: "Gnocchi", servingsDefault: 4, substitutions: [], ingredients: [ing("lg", "ing-gnocchi", "gnocchi", 32, "ounce"), ing("la", "ing-arugula", "arugula", 5, "ounce"), ing("lz", "ing-lzest", "lemon zest", 1, "teaspoon")], allSteps: a, steps: a },
    { dishId: "dt", positionIndex: 1, role: "side", title: "Tomatoes", servingsDefault: 4, substitutions: [], ingredients: [ing("lt", "ing-tom", "cherry tomatoes", 1, "pint"), ing("lj", "ing-ljuice", "lemon juice", 1, "tablespoon")], allSteps: b, steps: b },
  ];
  m.dishes[0].allSteps[2].text = "Toss the arugula with 1 teaspoon lemon zest in a bowl.";
  m.dishes[1].allSteps[0].text = "Roast the tomatoes on the other half of the sheet pan, then splash with 1 tablespoon lemon juice.";
  return m;
}
const PAN_ISSUES: Q0Issue[] = [
  issue(1, { class: 1, dish: "Gnocchi", stepIndex: 1, where: "step 1", quote: "Spread the gnocchi on half of the hot pan", why: "Crowded.", fix: "Use the whole pan for the gnocchi." }),
  issue(2, { class: 3, dish: "Gnocchi", ingredient: "1 teaspoon lemon zest", stepIndex: 2, where: `ingredient "1 teaspoon lemon zest" · step 2`, quote: "1 teaspoon lemon zest", why: "No lemon to buy.", fix: "Add 1 lemon." }),
];
function planPan(input: Partial<PatchInput>, issues = PAN_ISSUES, m = panMeal()) {
  const { ids, json } = editorPayload(m, issues);
  const printed = new Map<string, string>();
  for (const d of (json as { meal: { dishes: Array<{ ingredients: Array<{ id: string; printed: string }> }> } }).meal.dishes) for (const i of d.ingredients) printed.set(ids.line.get(i.id)!.rowId, i.printed);
  const stepId = (row: string) => [...ids.step.entries()].find(([, v]) => v.rowId === row)![0];
  const lineId = (row: string) => [...ids.line.entries()].find(([, v]) => v.rowId === row)![0];
  return { r: checkPatch(m, { step_edits: [], line_edits: [], new_lines: [], declined: [], ...input }, ids, issues, new Map([["lemon", LEMON]]), printed), stepId, lineId, m };
}
const stepEditOf = (m: CatMeal, id: string, row: string, nu: string, answers: number[]) => { const s = m.dishes.flatMap((d) => d.steps).find((x) => x.id === row)!; return { step_id: id, old_text: s.text, new_text: nu, old_minutes: s.estimatedMinutes, new_minutes: s.estimatedMinutes, answers }; };
const lineRemove = (m: CatMeal, id: string, row: string, answers: number[]) => { const i = m.dishes.flatMap((d) => d.ingredients).find((x) => x.id === row)!; const o = { quantity: i.quantity, unit: i.unit, name: i.name, note: i.preparationNote, optional: i.isOptional }; return { line_id: id, old: o, new: o, remove: true, answers }; };

describe("coupled steps (follow-up B)", () => {
  it("the preheat step and the OTHER dish's step on the same sheet pan ride along with the named step", () => {
    const m = panMeal();
    const p = planPan({}, PAN_ISSUES, m);
    const input = {
      step_edits: [
        stepEditOf(m, p.stepId("g1"), "g1", "Spread the gnocchi across the whole hot pan and roast 20 minutes.", [1]),
        stepEditOf(m, p.stepId("g0"), "g0", "Preheat the oven to 450°F and place two large rimmed sheet pans inside to heat.", [1]),
        stepEditOf(m, p.stepId("t0"), "t0", "Roast the tomatoes on the second sheet pan, then splash with 1 tablespoon lemon juice.", [1]),
      ],
      declined: [{ issue: 2, reason: "x" }],
    };
    const res = planPan(input, PAN_ISSUES, m).r;
    assert.deepEqual(res.rejections, []);
    assert.equal(res.edits.length, 3);
  });
  it("a step with no shared vessel or ingredient stays forbidden", () => {
    const m = panMeal();
    const p = planPan({}, PAN_ISSUES, m);
    const res = planPan({ step_edits: [
      stepEditOf(m, p.stepId("g1"), "g1", "Spread the gnocchi across the whole hot pan and roast 20 minutes.", [1]),
      stepEditOf(m, p.stepId("g2"), "g2", "Toss the arugula with 1 teaspoon lemon zest in a large bowl.", [1]),
    ] }, PAN_ISSUES, m).r;
    assert.ok(res.rejections.some((x) => /step 2 \(Gnocchi\).*shares no vessel or ingredient/.test(x)), res.rejections.join("|"));
  });
  it("singular and plural are one vessel; pans, pots and the water bath are separate classes", () => {
    assert.deepEqual([...vesselsIn("place two sheet pans inside")], ["pan"]);
    assert.deepEqual([...vesselsIn("bring the stockpot to a boil")], ["pot"]);
    assert.deepEqual([...vesselsIn("preheat the sous vide circulator")], ["bath"]);
  });
});

describe("produce bought whole (follow-up B)", () => {
  const lemon = { dish: "Gnocchi", line: { quantity: 1, unit: "each", name: "lemon", note: "zest, then juice", optional: false }, answers: [2] };
  it("a new lemon line with the zest line kept is rejected: the grocery list would buy two", () => {
    const res = planPan({ new_lines: [lemon], declined: [{ issue: 1, reason: "x" }] }).r;
    assert.ok(res.rejections.some((x) => /must fold into it.*lemon zest.*lemon juice/.test(x)), res.rejections.join("|"));
  });
  it("folding both the zest line and the OTHER dish's juice line is accepted", () => {
    const m = panMeal();
    const p = planPan({}, PAN_ISSUES, m);
    const res = planPan({ new_lines: [lemon], line_edits: [lineRemove(m, p.lineId("lz"), "lz", [2]), lineRemove(m, p.lineId("lj"), "lj", [2])], declined: [{ issue: 1, reason: "x" }] }, PAN_ISSUES, m).r;
    assert.deepEqual(res.rejections, []);
    assert.equal(res.edits.filter((e) => e.kind === "ingredient" && e.new === null).length, 2);
  });
  it("removing the juice line without adding a lemon is not 'required' — rejected", () => {
    const m = panMeal();
    const p = planPan({}, PAN_ISSUES, m);
    const res = planPan({ line_edits: [lineRemove(m, p.lineId("lj"), "lj", [2])], declined: [{ issue: 1, reason: "x" }] }, PAN_ISSUES, m).r;
    assert.ok(res.rejections.some((x) => /lemon juice.*no issue it answers names it/.test(x)), res.rejections.join("|"));
  });
});

describe("the second round (follow-up B)", () => {
  const gate = (o: Partial<ReturnType<typeof reviewGate>>) => ({ ok: false, reasons: [], allowed: [], ruled: [], verdictAfter: "fix", fresh: [], still: [], ...o });
  const r: ReviewIssue = { class: 2, severity: "fix", dish: "Grilled Chicken", ingredient: "2 teaspoons fresh rosemary", stepIndex: 5, quote: "rosemary", why: "never added", fix: "add it in step 5" };
  it("runs only for a new issue with every answered issue gone", () => {
    assert.ok(wantsSecondRound(gate({ fresh: [r] })));
    assert.ok(!wantsSecondRound(gate({ fresh: [r], still: [r] })), "a patch that failed its own job is not retried");
    assert.ok(!wantsSecondRound(gate({ ok: true })));
  });
  it("a round 2 that declines every new issue rejects the meal (round 1's re-review failed)", () => {
    assert.match(roundTwoDeclined(2, 0, 0) ?? "", /declined every new issue/);
    assert.equal(roundTwoDeclined(2, 1, 0), null, "round 2 edits go to the gate");
    assert.equal(roundTwoDeclined(1, 0, 0), null, "round 1 declining is just 'declined'");
  });
  it("numbers the new issues after the meal's own", () => {
    const xs = secondRoundIssues([r], ISSUES, { id: MEAL, title: "Grilled Chicken" });
    assert.equal(xs[0].n, 3);
    assert.equal(xs[0].where, `ingredient "2 teaspoons fresh rosemary" · step 5`);
  });
  it("round 2 cannot edit a line round 1 added", () => {
    const m = patchMeal(meal(), [lemonLine]);
    const { ids, json } = editorPayload(m, ISSUES);
    const added = [...ids.line.entries()].find(([, v]) => v.rowId.startsWith("new:"))![0];
    const printed = new Map<string, string>();
    for (const d of (json as { meal: { dishes: Array<{ ingredients: Array<{ id: string; printed: string }> }> } }).meal.dishes) for (const i of d.ingredients) printed.set(ids.line.get(i.id)!.rowId, i.printed);
    const o = { quantity: 1, unit: "each", name: "lemon", note: "cut into wedges", optional: false };
    const res = checkPatch(m, { step_edits: [], line_edits: [{ line_id: added, old: o, new: { ...o, quantity: 2 }, remove: false, answers: [2] }], new_lines: [], declined: [] }, ids, ISSUES, new Map(), printed);
    assert.ok(res.rejections.some((x) => /added in round 1 cannot be edited/.test(x)));
  });
  it("applies round 2 after round 1 in one transaction (round 2's old is round 1's new)", async () => {
    const t = db();
    const one = stepEdit(S1) as Extract<Edit, { kind: "step" }>;
    const second: Edit = { ...one, round: 2, old: { text: S1_FIX, minutes: 12 }, new: { text: `${S1_FIX} Rest 5 minutes.`, minutes: 17 } };
    const [, a1, a2] = await applyPatch(fakeTx(t), MEAL, [second, stepEdit(S1)], spyDeps().deps);
    assert.deepEqual([a1.applied, a2.applied], [1, 1]);
    assert.equal(t.recipeInstructionStep.find((s) => s.id === "st-1")!.stepTextRaw, `${S1_FIX} Rest 5 minutes.`);
  });
});

describe("issues.csv where", () => {
  it("parses the ingredient and the step out of CAT-Q0's where column", () => {
    assert.deepEqual(parseWhere(`ingredient "1 cup rice" · step 3`), { ingredient: "1 cup rice", stepIndex: 3 });
    assert.deepEqual(parseWhere("step 12"), { ingredient: null, stepIndex: 12 });
  });
});
