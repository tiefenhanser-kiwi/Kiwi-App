// Side-by-side dumps + an automatic quantity diff for narration. No DB, no AI.
import fs from "node:fs";
const f = (k, l, a) => { try { return JSON.parse(fs.readFileSync(`${k}__${l}__${a}.json`, "utf8")); } catch { return null; } };
const mode = process.argv[2];
const qty = (s) => (s.match(/(\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛])\s*(?:[a-zA-Z]+)?/g) ?? []).map((x) => x.replace(/\s+/g, " ").trim().toLowerCase()).sort();
if (mode === "narr") {
  const plan = process.argv[3];
  for (const arm of ["A", "C", "B"]) {
    const r = f("prep.narrate_steps", plan, arm);
    console.log(`\n================ ${plan} · arm ${arm} (${r.metadata.model}) ================`);
    for (const s of r.data.steps) console.log(`\n[${s.stepId}] ${s.title}\n${s.instructions}${s.storageNote ? `\n  storage: ${s.storageNote}` : ""}`);
  }
}
if (mode === "qty") {
  for (const plan of ["2251c7f5", "d06a721d", "c62587bb", "425da049", "163875ec"]) {
    const input = JSON.parse(fs.readFileSync(`narrInput__${plan}.json`, "utf8"));
    const inputQty = new Set(qty(JSON.stringify(input)));
    const byArm = {};
    for (const arm of ["A", "B", "C"]) {
      const r = f("prep.narrate_steps", plan, arm);
      if (!r?.success) { byArm[arm] = null; continue; }
      byArm[arm] = Object.fromEntries(r.data.steps.map((s) => [s.stepId, s]));
    }
    for (const arm of ["A", "B", "C"]) {
      const m = byArm[arm]; if (!m) { console.log(plan, arm, "— no output"); continue; }
      const ids = Object.keys(m);
      // A quantity the narrator wrote that appears nowhere in its input = invented.
      const invented = ids.flatMap((id) => qty(m[id].instructions).filter((q) => /\d|[½⅓⅔¼¾⅛]/.test(q) && !inputQty.has(q)).map((q) => `${id}:${q}`));
      console.log(plan, arm, `steps=${ids.length}`, `invented-qty=${invented.length}`, invented.slice(0, 8).join(" | "));
    }
    if (byArm.A && byArm.C) {
      const diff = Object.keys(byArm.A).filter((id) => byArm.C[id] && qty(byArm.A[id].instructions).join() !== qty(byArm.C[id].instructions).join());
      console.log(plan, "A vs C steps whose quantity tokens differ:", diff.length, diff.join(" "));
      const missing = Object.keys(byArm.A).filter((id) => !byArm.C[id]);
      if (missing.length) console.log(plan, "in A not C:", missing.join(" "));
    }
  }
}
if (mode === "gen") {
  const set = process.argv[3];
  for (const arm of ["A", "C"]) {
    const r = f("wizard.set_preferences.generate", set, arm);
    console.log(`\n================ ${set} · arm ${arm} (${r.metadata.model}) ================`);
    for (const c of r.data.candidates) {
      console.log(`\n■ ${c.title}  [${c.tags.join(", ")}]  ${JSON.stringify(c.dailyMacros)}`);
      c.mealTitles.forEach((t, i) => console.log(`   ${i + 1}. ${t}${(c.storeSlots ?? []).some((s) => s.slotIndex === i) ? "  (catalog)" : ""}`));
      for (const b of c.whyBullets) console.log(`   · ${b}`);
    }
  }
}
if (mode === "meal") {
  const label = process.argv[3];
  for (const arm of ["A", "C", "B"]) {
    const e = f("wizard.candidate.expand", label, arm);
    const fin = f("wizard.candidate.finalize_steps", label, arm);
    console.log(`\n================ ${label} · arm ${arm} (${e.metadata.model}) ================`);
    for (const m of e.data.meals) {
      console.log(`MEAL ${m.title} · ${m.estimatedTimeMinutes} min · servings ${m.servings ?? "?"}`);
      for (const d of m.dishes) {
        console.log(` DISH ${d.title} (${d.role ?? d.dishRole ?? ""}) macros=${JSON.stringify(d.macros ?? d.macrosPerServing ?? null)}`);
        for (const i of d.ingredients) console.log(`   - ${i.quantity} ${i.unit} ${i.name}${i.preparationNote ? `, ${i.preparationNote}` : ""}`);
      }
    }
    console.log(` STEPS (finalize, same arm, input = arm A's expand):`);
    for (const ds of fin.data.dishSteps) {
      console.log(`  dish ${ds.mealIndex}.${ds.dishIndex}`);
      ds.steps.forEach((s, i) => console.log(`   ${i + 1}. [${s.phaseType} · ${s.estimatedMinutes}m${s.isTimingSensitive ? " · timed" : ""}] ${s.text}`));
    }
  }
}
