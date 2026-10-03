// Sonnet 5.5 side-by-side · P5 — aggregate out/results.jsonl into one table per
// key × arm. No DB, no AI.
// Run: node --import tsx scripts/_scratch/sonnet55/p5-report.ts
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "out");
interface Row {
  key: string; label: string; arm: string; model: string; success: boolean; reason: string | null;
  retries: number; inTok: number; outTok: number; cacheRd: number; cacheWr: number; usd: number; ms: number;
  stops: string[]; thinkingBlocks: number; extra?: Record<string, unknown>;
}
const rows: Row[] = fs.readFileSync(path.join(OUT, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// A later run of the same key/label/arm supersedes an earlier one.
const latest = new Map<string, Row>();
for (const r of rows) latest.set(`${r.key}|${r.label}|${r.arm}`, r);

const ARM_NAME: Record<string, string> = { A: "4.6 (today)", B: "5.5 adaptive", C: "5.5 between_tools" };
const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const keys = [...new Set([...latest.values()].map((r) => r.key))];
for (const key of keys) {
  console.log(`\n### ${key}`);
  console.log("| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of ["A", "B", "C"]) {
    const rs = [...latest.values()].filter((r) => r.key === key && r.arm === arm);
    if (!rs.length) continue;
    const pass = rs.filter((r) => r.success && r.extra?.assembled !== false).length;
    const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
    const bad = rs.flatMap((r) => r.stops).filter((s) => s !== "end_turn" && s !== "tool_use");
    console.log(
      `| ${ARM_NAME[arm]} | ${pass}/${rs.length} | ${sum((r) => r.retries)} | ${bad.length ? bad.join(" ") : "—"} | ` +
        `${sum((r) => r.inTok)}+${sum((r) => r.cacheRd)}+${sum((r) => r.cacheWr)} | ${sum((r) => r.outTok)} | ` +
        `$${sum((r) => r.usd).toFixed(4)} | $${(sum((r) => r.usd) / rs.length).toFixed(4)} | ` +
        `${(p50(rs.map((r) => r.ms)) / 1000).toFixed(1)} | ${(Math.max(...rs.map((r) => r.ms)) / 1000).toFixed(1)} |`,
    );
  }
  const ttfc = [...latest.values()].filter((r) => r.key === key && r.extra?.ttfcMs != null);
  if (ttfc.length)
    console.log(`first-candidate ms: ${ttfc.map((r) => `${r.arm}/${r.label}=${r.extra!.ttfcMs}`).join(" · ")}`);
  const asm = [...latest.values()].filter((r) => r.key === key && r.extra?.assembled === false);
  for (const r of asm) console.log(`⚠ ${r.arm}/${r.label} narration incomplete: ${r.extra!.assembleError}`);
}
const spend = JSON.parse(fs.readFileSync(path.join(OUT, "spend.json"), "utf8")).usd;
console.log(`\ntotal measured spend $${spend.toFixed(3)} (+$0.003 for p0)`);
