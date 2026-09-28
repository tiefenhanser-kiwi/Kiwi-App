// [grocery] B2 · Part A — probe 5. READ-ONLY, files only.
//   I — R1's actual population on the 20-list corpus at the B1 after-state:
//       plan-derived rows sharing one ingredientId.
//   plus: where the three §2 residue shapes actually are.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const DIR = "scripts/grocery-census/out";
const files = readdirSync(DIR).filter((f) => f.startsWith("b1__") && f.endsWith(".json"));
console.log(`corpus files: ${files.length}`);

let collisionsConsolidated = 0, collisionsFinal = 0, totalRows = 0, recurring = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  for (const stage of ["consolidated", "final"] as const) {
    const rows = j[stage] ?? [];
    const byId = new Map<string, any[]>();
    for (const r of rows) {
      if (stage === "consolidated") { totalRows++; if (r.isRecurringItem) recurring++; }
      if (!r.ingredientId) continue;
      let a = byId.get(r.ingredientId); if (!a) { a = []; byId.set(r.ingredientId, a); }
      a.push(r);
    }
    for (const [id, rs] of byId) {
      if (rs.length < 2) continue;
      const names = new Set(rs.map((r: any) => (r.canonicalName ?? r.name ?? "").toLowerCase()));
      if (stage === "consolidated") collisionsConsolidated++; else collisionsFinal++;
      console.log(`  [${f}] ${stage} ingredientId ${id.slice(0, 8)} x${rs.length}  names={${[...names].join(" | ")}}  units={${rs.map((r: any) => r.unit).join(",")}}`);
    }
  }
}
console.log(`\nconsolidated rows: ${totalRows} (recurring synthetics ${recurring})`);
console.log(`ingredientId collisions — consolidated ${collisionsConsolidated} · final ${collisionsFinal}`);

// the three residue shapes
const SHAPES = [/garlic head/i, /rotisserie chicken rotisserie chicken/i, /white onion White onion/i, /head garlic/i];
console.log(`\n=== the residue shapes, in the rendered lines at the B1 after-state ===`);
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  for (const r of j.rendered ?? []) {
    if (SHAPES.some((re) => re.test(r.line))) console.log(`  [${f}] ${r.line}`);
  }
}
