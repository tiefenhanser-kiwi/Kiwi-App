// [prepcook] Part J.1c — census.md from out/census_head.json (engine v4) and
// out/census_work.json (engine v5), both computed for the same pinned day.
//   node scripts/prep-cook-census/part-j1c/table.cjs
const fs = require("fs");
const dir = "scripts/prep-cook-census/part-j1c";
const h = JSON.parse(fs.readFileSync(`${dir}/out/census_head.json`, "utf8"));
const w = JSON.parse(fs.readFileSync(`${dir}/out/census_work.json`, "utf8"));
const L = [
  "Engine v4 (HEAD, 1fabbe5's prep files) → v5 (J.1c), both as of 2026-10-04, stand-in prose (neither count depends on prose).",
  "",
  '| plan | containers | minutes (header) | protein minutes | "same tub" steps | one-portion steps printed twice | single-dish contents lids | longest lid |',
  "|---|---|---|---|---|---|---|---|",
];
const keys = ["containers", "minutes", "p", "sameTub", "twice", "singleDishContentLids"];
const tot = Object.fromEntries(keys.map((k) => [k, [0, 0]]));
for (const a of h) {
  const b = w.find((x) => x.planId === a.planId);
  const v = (o, k) => (k === "p" ? o.byPhase.proteins ?? 0 : o[k]);
  for (const k of keys) { tot[k][0] += v(a, k); tot[k][1] += v(b, k); }
  L.push(`| ${a.code} | ${keys.map((k) => `${v(a, k)} → ${v(b, k)}`).join(" | ")} | ${a.maxContainerName} → ${b.maxContainerName} |`);
}
L.push(`| **total (${h.length})** | ${keys.map((k) => `**${tot[k][0]} → ${tot[k][1]}**`).join(" | ")} | |`);
fs.writeFileSync(`${dir}/census.md`, `${L.join("\n")}\n`);
console.log(L.join("\n"));
