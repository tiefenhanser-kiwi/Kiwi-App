// THX-2G — the review page Hans reads before anything is made public. ONE
// self-contained HTML file, built from the DATABASE rows (never the model
// payload): per meal the image, title, dishes in stored order, ingredients with
// quantities at the meal's servings, steps, derived times, allergens with their
// sources, and generate.ts's flags. Images are embedded (data: URIs) when they
// can be fetched, so the file works offline and can be forwarded as is.
//
//   node --env-file=.env --import tsx scripts/thx2/review.ts            # → scripts/_scratch/thx2/review-<dev|production>.html
//   node --env-file=.env --import tsx scripts/thx2/review.ts --no-embed # link the images instead of embedding them
//
// Read-only. scripts/_scratch/ is gitignored.
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { flagsFor, loadTargets, type Flag, type Thx2Target } from "./thx2Core";
import { flagInputs, loadThx2Meals, type MealGraph } from "./thx2Db";

const EMBED = !process.argv.includes("--no-embed");
const { host, mode } = assertScriptDatabase("thx2/review");
console.log(`database: ${host} (${mode})`);

const file = loadTargets();
const byKey = new Map(file.targets.map((t) => [t.key, t]));
const prisma = new PrismaClient();
const meals = await loadThx2Meals(prisma);
await prisma.$disconnect();
// targets.json order (feasts, alternates, Friday), not alphabetical
const order = new Map(file.targets.map((t, i) => [t.key, i]));
meals.sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));

const images = new Map<string, string>();
if (EMBED) {
  for (const m of meals) {
    if (!m.imageUrl) continue;
    try {
      const res = await fetch(m.imageUrl);
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "image/jpeg";
      images.set(m.id, `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`);
    } catch {
      /* fall back to the link */
    }
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const FRACTIONS: Array<[number, string]> = [[1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"]];
function qty(q: number): string {
  const whole = Math.floor(q + 1e-9);
  const frac = q - whole;
  if (frac < 0.02) return String(whole);
  const hit = FRACTIONS.find(([v]) => Math.abs(frac - v) < 0.02);
  if (hit) return whole > 0 ? `${whole}${hit[1]}` : hit[1];
  return q.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const flagsByMeal = new Map<string, Flag[]>(meals.map((m) => {
  const t = byKey.get(m.key);
  return [m.id, t ? flagsFor(t, file, flagInputs(m)) : [{ code: "dish_count", detail: "key not in targets.json" } as Flag]];
}));

function mealSection(m: MealGraph, t: Thx2Target | undefined): string {
  const flags = flagsByMeal.get(m.id) ?? [];
  const img = images.get(m.id) ?? m.imageUrl;
  const image = img
    ? `<img src="${esc(img)}" alt="${esc(m.title)}" loading="lazy">`
    : `<div class="noimg">image ${esc(m.imageStatus)} (attempts ${m.imageAttempts})</div>`;
  const dishes = m.dishes.map((d) => `
    <div class="dish">
      <h4>${d.positionIndex + 1}. ${esc(d.title)} <span class="role">${esc(d.role)}</span>${d.tags.length ? ` <span class="tags">${d.tags.map(esc).join(" · ")}</span>` : ""}</h4>
      <div class="cols">
        <div>
          <h5>Ingredients <span class="muted">(for ${d.servingsDefault})</span></h5>
          <ul>${d.ingredients.map((i) => `<li>${esc(qty(i.quantity))} ${esc(i.unit)} <b>${esc(i.name)}</b>${i.preparationNote ? `, ${esc(i.preparationNote)}` : ""}${i.isOptional ? ' <span class="muted">(optional)</span>' : ""}${i.pathKey ? ` <span class="path">${esc(i.pathKey)}</span>` : ""}</li>`).join("")}</ul>
          ${d.substitutions.length ? `<h5>Store-bought swaps</h5><ul>${d.substitutions.map((s) => `<li>${esc(qty(s.quantity))} ${esc(s.unit)} <b>${esc(s.product)}</b> replaces ${s.replaces.map(esc).join(", ")}</li>`).join("")}</ul>` : ""}
        </div>
        <div>
          <h5>Steps</h5>
          <ol>${d.steps.map((s) => `<li><span class="step">${esc(s.phaseType)} · ${s.estimatedMinutes} min${s.isTimingSensitive ? " · attended" : ""}${s.pathKey ? ` · ${esc(s.componentKey)}/${esc(s.pathKey)}` : ""}${s.parallelGroup ? ` · ${esc(s.parallelGroup)}` : ""}</span> ${esc(s.text)}</li>`).join("")}</ol>
        </div>
      </div>
    </div>`).join("");
  const sources = Object.entries(m.allergenSources).map(([tok, names]) => `<li><b>${esc(tok)}</b>: ${names.map(esc).join(", ")}</li>`).join("");
  return `
  <section id="${esc(m.key)}">
    <div class="head">
      ${image}
      <div>
        <h2>${esc(m.title)}</h2>
        ${m.displayTitle ? `<p class="muted">display: ${esc(m.displayTitle)}</p>` : ""}
        <p>${esc(m.description)}</p>
        <p class="facts"><b>${m.estimatedTimeMinutes} min</b> total (derived) · <b>${m.activeTimeMinutes ?? "–"} min</b> active · serves <b>${m.servingsDefault}</b> · ${esc(m.difficulty)} · ${esc(m.cuisineType)} · ${m.isPublic ? '<span class="bad">PUBLIC</span>' : "not public"}</p>
        <p class="muted">${esc(m.key)} · ${esc(m.id)} · tags ${m.tags.map(esc).join(", ")}</p>
        ${t ? `<p class="muted">asked: ${t.dishes.map((d) => esc(d.name)).join(" · ")}${t.products.length ? ` · store-bought: ${t.products.map(esc).join("; ")}` : ""}${t.leftovers?.length ? ` · leftovers: ${t.leftovers.map(esc).join("; ")}` : ""}</p>` : ""}
        <p><b>Allergens:</b> ${m.allergens.length ? m.allergens.map(esc).join(", ") : "none"}</p>
        <ul class="sources">${sources}</ul>
        ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>🚩 <b>${esc(f.code)}</b> ${esc(f.detail)}</li>`).join("")}</ul>` : '<p class="ok">No flags.</p>'}
      </div>
    </div>
    ${dishes}
  </section>`;
}

const rows = meals.map((m) => {
  const t = byKey.get(m.key);
  const flags = flagsByMeal.get(m.id) ?? [];
  return `<tr><td><a href="#${esc(m.key)}">${esc(m.title)}</a></td><td>${esc(t?.kind ?? "?")}</td><td>${m.dishes.length}${t ? `/${t.dishes.length}` : ""}</td><td>${m.servingsDefault}</td><td>${m.estimatedTimeMinutes} / ${m.activeTimeMinutes ?? "–"}</td><td>${m.allergens.map(esc).join(", ")}</td><td>${flags.length ? `🚩 ${flags.length}` : "–"}</td><td>${esc(m.imageStatus)}</td></tr>`;
}).join("");
const missing = file.targets.filter((t) => !meals.some((m) => m.key === t.key));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thanksgiving Review</title>
<style>
:root{--bg:#fbfaf7;--fg:#1f1d1a;--muted:#6b665e;--card:#fff;--line:#e6e1d8;--accent:#9a4f1d;--bad:#b42318;--ok:#2f6f3e}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ece8e1;--muted:#a39d93;--card:#211f1c;--line:#3a3631;--accent:#e59a5f;--bad:#ff6b5e;--ok:#7cc48c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 80px}h1{margin:0 0 4px}h2{margin:0 0 6px;color:var(--accent)}h4{margin:18px 0 6px}h5{margin:8px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px;margin:16px 0 32px;background:var(--card)}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 28px}
.head{display:grid;grid-template-columns:280px 1fr;gap:20px}.head img,.noimg{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--line)}.noimg{display:flex;align-items:center;justify-content:center;color:var(--muted)}
.cols{display:grid;grid-template-columns:1fr 1.4fr;gap:20px}ul,ol{margin:0;padding-left:20px}li{margin:2px 0}
.muted{color:var(--muted);font-size:13px}.role,.path,.tags{font-size:12px;color:var(--muted);font-weight:400;border:1px solid var(--line);border-radius:6px;padding:0 6px}
.step{font-size:12px;color:var(--muted)}.flags{color:var(--bad);padding-left:4px;list-style:none}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}.facts{font-size:14px}.sources{font-size:13px}
.dish{border-top:1px solid var(--line);margin-top:14px}
@media (max-width:720px){.head,.cols{grid-template-columns:1fr}table{font-size:12px}}
</style></head><body><main>
<h1>Thanksgiving review</h1>
<p class="muted">${esc(mode)} database ${esc(host)} · generated ${new Date().toISOString()} · ${meals.length} of ${file.targets.length} targets written · ${meals.filter((m) => m.isPublic).length} public${missing.length ? ` · not written: ${missing.map((t) => esc(t.key)).join(", ")}` : ""}</p>
<p class="muted">Times are the stored derived numbers (the scheduler's, D-WS9-235); a feast's total is known to read short across 8 dishes (BUG-397). Quantities are at each meal's own servings. Flags are reported, never fixed by the script.</p>
<table><thead><tr><th>Meal</th><th>Kind</th><th>Dishes</th><th>Serves</th><th>Total / active</th><th>Allergens</th><th>Flags</th><th>Image</th></tr></thead><tbody>${rows}</tbody></table>
${meals.map((m) => mealSection(m, byKey.get(m.key))).join("")}
</main></body></html>`;

const dir = "scripts/_scratch/thx2";
mkdirSync(dir, { recursive: true });
const out = `${dir}/review-${mode}.html`;
writeFileSync(out, html);
console.log(`${meals.length} meals · ${images.size} images embedded · ${[...flagsByMeal.values()].reduce((a, f) => a + f.length, 0)} flags → ${resolve(out)}`);
