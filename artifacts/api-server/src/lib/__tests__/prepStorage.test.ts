// WS9 BUG-338 / D-WS9-298 — the storage table, the protein rules, the overlay.
//
// The census (P-R3) found 57 storage windows that expire before their own cook
// day across 7 of 13 plans, 15 of them raw flesh, max lag 5 days. None of it was
// the model's fault: `loadPrepWeekInput` read no date, so every "up to 2 days"
// was a guess by something that could not know when the meal was cooked.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_TABLE,
  DEFAULT_STORAGE,
  PROTEINS_PHASE_NOTE,
  SHELF_STABLE_PROTEIN,
  applyStorageOverlay,
  judgeProteinStep,
  nounFormTitle,
  storageClassFor,
  type StorageContext,
} from "../prepStorage";
import type { PrepWeekResult } from "../ai/schemas/prepWeek";

// ── the table ───────────────────────────────────────────────────────────────

describe("D-WS9-298 — the storage table", () => {
  it("classifies each food class the census named", () => {
    const cases: [string, string][] = [
      ["salmon fillets", "raw-fish"],
      ["skirt steak", "raw-meat"],
      ["boneless skinless chicken thighs", "raw-meat"],
      ["fresh cilantro chopped", "leafy-herbs"],
      ["lime juice", "citrus-juice"],
      ["lime cut into wedges", "citrus-wedges"],
      ["white onion finely diced", "cut-alliums"],
      ["jalapeño seeded and minced", "cut-peppers"],
      ["jasmine rice", "cooked-grains"],
      ["teriyaki glaze", "sauces-dressings"],
      ["ground cumin chili powder spice blend", "spice-blend"],
    ];
    for (const [text, key] of cases) {
      assert.equal(storageClassFor(text).key, key, `"${text}" → ${storageClassFor(text).key}`);
    }
  });

  it("🔴 RAW FLESH IS FIRST IN THE TABLE, and the order is the rule", () => {
    // "chicken thighs, sliced" matches raw-meat AND nothing else, but "salmon in
    // a marinade" would match `sauces-dressings` too. First match wins, so the
    // shortest window has to come first or a 2-day food gets a 5-day note.
    assert.equal(STORAGE_TABLE[0].key, "raw-fish");
    assert.equal(STORAGE_TABLE[1].key, "raw-meat");
    assert.equal(storageClassFor("salmon fillets for the teriyaki glaze").days, 2);
  });

  it("🔴 the BOWL NAME is a label, not contents — two opposite mistakes", () => {
    // Without the label, "Loaded Vegetarian Nachos seasoning" holding cumin,
    // chili powder and garlic powder read as loose produce: none of those three
    // words says "blend".
    assert.equal(
      storageClassFor("ground cumin chili powder garlic powder", "Loaded Vegetarian Nachos seasoning").key,
      "spice-blend",
    );
    // WITH the label reaching every class, a jar of dry spices matched RAW MEAT
    // on the word "Chicken" in its dish's name and was told to cook within 2
    // days. The raw classes read the contents alone.
    assert.equal(
      storageClassFor("ground cumin chili powder garlic powder", "Sheet-Pan Chicken Fajitas seasoning bowl").key,
      "spice-blend",
    );
    // …while real raw flesh is still caught, label or no label.
    assert.equal(storageClassFor("salmon fillets", "Teriyaki Salmon glaze jar").key, "raw-fish");
    assert.equal(storageClassFor("soy sauce sesame oil honey", "Teriyaki Salmon glaze jar").key, "sauces-dressings");
  });

  // ── BUG-340 — shelf-stable proteins ───────────────────────────────────────

  it("🔴 anchovy paste is not raw fish — a jar that keeps for months", () => {
    // The founding case. `Ingredient.category` is Protein, so it reached the
    // raw-fish regex on the word "anchovy" and was told to cook within 2 days.
    assert.equal(storageClassFor("anchovy paste").key, "shelf-stable");
    assert.match(storageClassFor("anchovy paste").note, /keeps in its own jar/);
    // …and the LABEL still decides the kind of mixture, exactly as before: a
    // tsp of paste measured into the Caesar dressing jar is a dressing, and
    // gets the dressing's 5 days. What BUG-340 removes is the RAW-FISH window,
    // not the bowl's own identity.
    const inBowl = storageClassFor("1 tsp anchovy paste", "Classic Caesar Salad dressing jar");
    assert.equal(inBowl.key, "sauces-dressings");
    assert.notEqual(inBowl.key, "raw-fish");
  });

  it("🔴 the shelf-stable form is SUBTRACTED, so real flesh beside it still wins", () => {
    // An early return would have been the dangerous version of this fix: one
    // jar of anchovy paste in a container would have cleared the raw-fish note
    // off the salmon sharing it.
    assert.equal(storageClassFor("salmon fillets, anchovy paste").key, "raw-fish");
    assert.equal(storageClassFor("salmon fillets, anchovy paste").days, 2);
    // …and what is left of a mixed container is classified on its remainder,
    // through the table's existing order (alliums before peppers).
    assert.equal(storageClassFor("cured chorizo, red peppers, onion").key, "cut-alliums");
    assert.equal(storageClassFor("cured chorizo, red peppers").key, "cut-peppers");
  });

  it("🔴 BACON AND HAM ARE CURED AND LIVE IN THE FRIDGE — the adjective is not the rule", () => {
    // The trap this fix was one regex away from: /cured|smoked|dried/ matches
    // 59 Protein-category names on dev and 53 of them are refrigerated. A
    // shelf-stable list is a list of FORMS, not of preservation words.
    for (const n of [
      "thick-cut bacon", "smoked bacon", "deli ham", "smoked ham hock",
      "italian pork sausage", "kielbasa (smoked polish sausage)", "smoked chicken breast",
      "andouille smoked sausage",
    ]) {
      assert.equal(storageClassFor(n).key, "raw-meat", `"${n}" must keep the 2-day window`);
    }
    // While the genuinely ambient forms do not.
    for (const n of ["genoa salami", "prosciutto di parma", "pepperoni slices", "spanish cured chorizo"]) {
      assert.equal(storageClassFor(n).key, "shelf-stable", `"${n}" is not raw flesh`);
    }
  });

  it("the shelf-stable test is repeatable — a /g/ regex would answer every other call", () => {
    // `lastIndex` on a shared global instance is why this is two regexes from
    // one source. Ten identical questions, ten identical answers.
    for (let i = 0; i < 10; i++) {
      assert.equal(storageClassFor("anchovy paste").key, "shelf-stable", `call ${i}`);
      assert.equal(SHELF_STABLE_PROTEIN.test("anchovy paste"), true, `call ${i}`);
    }
  });

  it("an unmatched food falls to the SHORTEST produce window, not the longest", () => {
    // The safe direction: a note that says 3 days for something that keeps 5
    // wastes a little food; the other way makes someone ill.
    assert.equal(storageClassFor("dragon fruit").key, DEFAULT_STORAGE.key);
    assert.equal(DEFAULT_STORAGE.days, 3);
    const longest = Math.max(...STORAGE_TABLE.map((c) => c.days));
    assert.ok(DEFAULT_STORAGE.days < longest, "the fallback must not be the most generous window");
  });
});

// ── the protein rules ───────────────────────────────────────────────────────

describe("D-WS9-298 — proteins, by their cook day", () => {
  it("≤ 2 days keeps, with the fridge note", () => {
    assert.equal(judgeProteinStep(0).kind, "keep");
    assert.equal(judgeProteinStep(2).kind, "keep");
    assert.equal(judgeProteinStep(2).note, "Covered in the fridge — cook within 2 days.");
  });

  it("🔴 > 2 days is DEMOTED — a Friday salmon is not prepped on Sunday", () => {
    // The P1 class, and the reason the rule exists: the census had raw fish
    // portioned 5 days before it was cooked, with a note saying 2.
    const v = judgeProteinStep(5);
    assert.equal(v.kind, "demote");
    assert.match(v.note, /5 days out/);
  });

  it("🔴 an UNASSIGNED day is not day zero — it gets its own sentence", () => {
    // 4 of the 13 census plans carry no dates at all. Telling that cook "cook
    // within 2 days" is the same false confidence the rule removes.
    const v = judgeProteinStep(undefined);
    assert.equal(v.kind, "unknown-day");
    assert.match(v.note, /prep this the day before you cook, or leave it for cook day/);
    assert.notEqual(v.kind, judgeProteinStep(0).kind);
  });

  it("a demoted title names the THING, never the action it forbids", () => {
    assert.equal(nounFormTitle(["baby yellow potatoes"]), "Baby yellow potatoes — cook day");
    assert.equal(nounFormTitle(["chicken breasts", "chicken thighs"]), "Chicken breasts and chicken thighs — cook day");
    for (const t of [nounFormTitle(["ripe avocado"]), nounFormTitle([])]) {
      assert.ok(!/^(Halve|Cut|Slice|Dice|Prep|Measure)\b/.test(t), `"${t}" opens with an imperative`);
    }
  });
});

// ── the overlay ─────────────────────────────────────────────────────────────

function result(steps: { stepKey: string; phase: string; title: string; storageNote?: string }[]): PrepWeekResult {
  const byPhase = (p: string) =>
    steps
      .filter((s) => s.phase === p)
      .map((s, i) => ({
        number: i + 1,
        stepKey: s.stepKey,
        title: s.title,
        instructions: "…",
        estimatedMinutes: 2,
        contributesToMealIds: ["00000000-0000-4000-8000-000000000001"],
        ...(s.storageNote ? { storageNote: s.storageNote } : {}),
      }));
  return {
    totalEstimatedMinutes: 10,
    phases: (["seasonings_dry", "sauces_marinades", "produce", "proteins"] as const).map((p) => ({
      phase: p,
      title: p,
      skippable: p === "seasonings_dry" || p === "sauces_marinades",
      steps: byPhase(p),
    })),
  } as PrepWeekResult;
}

const ctx = (o: Partial<StorageContext> & { phase: string }): StorageContext => ({
  text: "",
  ingredientNames: [],
  ...o,
});

describe("D-WS9-298 — the overlay, applied on every read", () => {
  it("🔴 the MODEL'S storage note is discarded, not merged", () => {
    // It was a guess by something that could not see a date. Keeping it as a
    // fallback would leave exactly the wrong answers on exactly the steps the
    // table does not cover.
    const r = result([{ stepKey: "s1", phase: "produce", title: "Chop the cilantro", storageNote: "Airtight, up to 9 days." }]);
    const out = applyStorageOverlay(r, new Map([["s1", ctx({ phase: "produce", text: "fresh cilantro", ingredientNames: ["fresh cilantro"] })]]));
    const step = out.phases.find((p) => p.phase === "produce")!.steps[0];
    assert.notEqual(step.storageNote, "Airtight, up to 9 days.");
    assert.match(step.storageNote!, /up to 3 days/);
  });

  it("a step the plan does not know loses its note rather than keeping an unverifiable one", () => {
    const r = result([{ stepKey: "ghost", phase: "produce", title: "?", storageNote: "Up to a month." }]);
    const out = applyStorageOverlay(r, new Map());
    assert.equal(out.phases.find((p) => p.phase === "produce")!.steps[0].storageNote, undefined);
  });

  it("the Proteins phase ALWAYS carries its line, even with no steps in it", () => {
    const out = applyStorageOverlay(result([]), new Map());
    assert.equal(out.phases.find((p) => p.phase === "proteins")!.note, PROTEINS_PHASE_NOTE);
    // …and no other phase gets one.
    for (const p of out.phases) if (p.phase !== "proteins") assert.equal(p.note, undefined);
  });

  it("🔴 a Friday salmon on a Sunday prep is DEMOTED and retitled", () => {
    const r = result([{ stepKey: "fish", phase: "proteins", title: "Portion the salmon fillets" }]);
    const out = applyStorageOverlay(
      r,
      new Map([["fish", ctx({ phase: "proteins", daysUntilCook: 5, ingredientNames: ["salmon fillets"] })]]),
    );
    const step = out.phases.find((p) => p.phase === "proteins")!.steps[0];
    assert.equal(step.skipSuggested, true);
    assert.equal(step.title, "Salmon fillets — cook day");
    assert.match(step.storageNote!, /5 days out/);
  });

  it("a Monday salmon on a Sunday prep is KEPT, with the 2-day note", () => {
    const r = result([{ stepKey: "fish", phase: "proteins", title: "Portion the salmon fillets" }]);
    const out = applyStorageOverlay(
      r,
      new Map([["fish", ctx({ phase: "proteins", daysUntilCook: 1, ingredientNames: ["salmon fillets"] })]]),
    );
    const step = out.phases.find((p) => p.phase === "proteins")!.steps[0];
    assert.equal(step.skipSuggested, undefined);
    assert.equal(step.title, "Portion the salmon fillets");
    assert.match(step.storageNote!, /cook within 2 days/);
  });

  it("🔴 an UNASSIGNED protein keeps its step AND gets the unknown-day line", () => {
    const r = result([{ stepKey: "hen", phase: "proteins", title: "Pat dry the chicken" }]);
    const out = applyStorageOverlay(
      r,
      new Map([["hen", ctx({ phase: "proteins", ingredientNames: ["chicken breasts"] })]]),
    );
    const step = out.phases.find((p) => p.phase === "proteins")!.steps[0];
    assert.equal(step.skipSuggested, undefined);
    assert.match(step.storageNote!, /prep this the day before you cook/);
  });

  it("🔴 BUG-340 — a shelf-stable protein IN the Proteins phase is still not raw flesh", () => {
    // Belt and braces with the phase classifier. If the catalog miscategorises
    // something tomorrow the way it miscategorised anchovy paste, the phase
    // alone must not be able to put "cook within 2 days" on a jar.
    const r = result([{ stepKey: "anch", phase: "proteins", title: "Measure the anchovy paste" }]);
    const out = applyStorageOverlay(
      r,
      new Map([["anch", ctx({ phase: "proteins", daysUntilCook: 5, text: "anchovy paste", ingredientNames: ["anchovy paste"] })]]),
    );
    const step = out.phases.find((p) => p.phase === "proteins")!.steps[0];
    assert.equal(step.skipSuggested, undefined, "a jar 5 days out is not demoted");
    assert.equal(step.title, "Measure the anchovy paste");
    assert.match(step.storageNote!, /keeps in its own jar/);
    assert.ok(!/2 days/.test(step.storageNote!), "the raw-flesh line reached a shelf-stable jar");
  });

  it("the overlay is PURE — the same input twice gives the same output", () => {
    // It runs on every read, including a cache hit, so it must not mutate the
    // cached blob it is handed.
    const r = result([{ stepKey: "s1", phase: "produce", title: "Chop", storageNote: "old" }]);
    const before = JSON.stringify(r);
    const m = new Map([["s1", ctx({ phase: "produce", text: "fresh cilantro" })]]);
    const a = applyStorageOverlay(r, m);
    const b = applyStorageOverlay(r, m);
    assert.equal(JSON.stringify(r), before, "the input was mutated");
    assert.deepEqual(a, b);
  });
});
