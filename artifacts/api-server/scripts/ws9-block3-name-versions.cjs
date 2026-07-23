// Plan-Gen Arc · List Expansion (D-WS9-062) — THROWAWAY A/B bake-off script.
//
//   node --env-file=.env scripts/ws9-block3-name-versions.cjs --axis-rule A
//   node --env-file=.env scripts/ws9-block3-name-versions.cjs --axis-rule B
//
// Reads the top-25 rows of ws9-block3-target-dishes.csv, calls the Anthropic
// API once per dish under one axis rule (A or B), and emits a per-version CSV.
// NOT wired into anything — does not touch the harness, storeFillDishes.ts,
// the store, or the DB. Review artifact only.
//
// Assembly contract: system = SHARED_STEER + AXIS_BLOCK[rule] + OUTPUT_SCHEMA,
// three separate constants concatenated at call time. The axis block is the
// ONLY thing that differs between A and B. The shared steer carries zero
// axis-rule language — folding it in would invalidate the bake-off.

const fs = require("fs");
const path = require("path");

const AnthropicPkg = require("@anthropic-ai/sdk");
const Anthropic = AnthropicPkg.default || AnthropicPkg;

// ── constants (VERBATIM — do not paraphrase) ─────────────────────────────────

const SHARED_STEER = `You are helping build a catalog of the most-cooked dinners in American homes. For a single well-known dish, you will decide how it splits into distinct dinner versions, and name each one.

You are naming meals, not writing recipes. Each version-name must read like a menu item a person would recognize and choose — clear, appetizing, scannable. No puns, no roman numerals, no version numbers, no bylines ("Kiwi's…"). Keep the dish's own identity legible: a reader scanning the list should instantly know what dinner they'd get.

Think of every dish as having a fixed identity and a wardrobe. Version variety comes from the wardrobe — the same dish dressed differently — never from surgery on the identity. You can change the outfit freely: preparation, seasoning, glaze, and what's served alongside. What you can't do is change who the dish fundamentally is. A burger has one identity ("burger") and a big wardrobe — smash, pub-style, blue cheese, mushroom-swiss are genuinely different dinners that are all still burgers. Some dishes carry their protein as part of the wardrobe: Chicken Alfredo, Shrimp Alfredo, and plain Fettuccine Alfredo are real, different versions, because for this dish the protein is an outfit, not surgery.

Identify the dish's true identity before you vary anything. A cherry Coke is a real version of Coke; a Dr. Pepper handed to someone who asked for Coke is just wrong. Dressing up a dish you've misidentified is worse than not varying it at all.

The wardrobe is roomier than a purist thinks, but it still has a line. A home cook might make carbonara with bacon instead of guanciale, or a quiche lorraine with ham instead of lardons, and it's still the dish — real cooking uses what's on hand. But add cream to carbonara, or drop the custard from a quiche, and it's no longer that dish. Note the difference between a substitution and a version: bacon-for-guanciale is the SAME version cooked with what you have, not a new one — don't turn ordinary substitutions into separate versions, that's padding.

Aim for a cohesive plate. When a dish has separate accompaniments, they should complete and balance the main, not just sit next to it — a heavy, rich, or fatty main wants something bright, acidic, or crisp to cut it; a lean, simple main wants heartier sides to round it into a full dinner. A mushroom-swiss burger with Spanish rice and an Asian slaw is three unrelated dishes on one plate; the same burger with a crisp vinegar slaw and fries is a meal. When the dish is already a complete meal in one vessel — a sheet-pan dinner, a one-pot chili, a loaded pasta bake — don't manufacture separate sides it doesn't need.

Cook like a good home cook, not a show-off. The goal is food people actually make and love, not food that's trying to impress. Don't reach for rare, expensive, or fussy ingredients to dress up a dish that doesn't need them — overcomplicating a good simple meal usually makes it worse, not better. But don't go bland either: a plate still needs acidity, contrast, crunch, and flavors that genuinely work together. The target is the version a great weeknight cook would be proud of, not a restaurant showing off and not a joyless health plate.

Honesty over quota — this is the most important rule. N is a target drawn from the dish's popularity, not a mandate. If a dish genuinely does not support N distinct, good dinners, deliver the number it does support and say why. A short list of real versions beats a padded list of contrived ones. Padding — six near-identical versions of a dish that only has three — recreates the exact near-clone problem this catalog exists to eliminate. Never invent a distinction that wouldn't change what a person actually eats.`;

const AXIS_BLOCK_A = `Decide the dish's axis, choosing exactly one:

- preparation — the versions differ in the dish itself (BBQ-Glazed Meatloaf, Italian Meatloaf, Classic Diner Meatloaf). Use this when the dish has real latitude in its own preparation.
- accompaniment — the base dish stays canonically intact and the versions differ by what's served alongside (Quiche Lorraine with a Green Salad; Quiche Lorraine with Roasted Potatoes; Quiche Lorraine with Tomato Soup). Use this when the dish has one correct form. The canonical dish never moves.

Pick the single axis that best fits the dish. Produce all N version-names along that one axis. Do not mix axes.`;

const AXIS_BLOCK_B = `Decide the dish's primary axis:

- preparation — the dish has real latitude in its own preparation (BBQ-Glazed Meatloaf, Italian Meatloaf, Classic Diner Meatloaf).
- accompaniment — the dish has one correct canonical form and varies by what's served alongside (Quiche Lorraine with a Green Salad; …with Roasted Potatoes; …with Tomato Soup). The canonical dish never moves.

Produce N version-names primarily along that axis. You may borrow one or two versions from the other axis when the dish genuinely supports it — e.g. a mostly-accompaniment dish that has one legitimate preparation variant (a Classic French Omelette that is mostly served-alongside variations but supports one Herb Omelette). Only borrow when the borrowed version is a real dinner someone would choose — never to pad to N. If you borrow, mark those versions with cross_axis: true.`;

const OUTPUT_SCHEMA = `Respond with only a JSON object of this exact shape, nothing else:

{
  "parent_dish": "<the input dish, verbatim>",
  "primary_axis": "preparation" | "accompaniment",
  "axis_note": "<one plain line: why this dish varies where it does>",
  "requested_versions": <N as integer>,
  "delivered_versions": <M as integer, M <= N>,
  "short_of_target": <true if M < N, else false>,
  "short_reason": "<one line if short; empty string otherwise>",
  "versions": [
    { "name": "<version name>", "cross_axis": <true or false> }
  ]
}

Under axis-rule A, cross_axis is always false. The versions array length must equal delivered_versions.`;

const AXIS_BLOCK = { A: AXIS_BLOCK_A, B: AXIS_BLOCK_B };

const MODEL = "claude-sonnet-4-6";
const TEMPERATURE = 0.7;
const MAX_TOKENS = 1024;

// N-per-dish tier table (D-WS9-057 rank bands — note 76–208, NOT 76–200).
function tierN(rank) {
  if (rank >= 1 && rank <= 25) return 6;
  if (rank >= 26 && rank <= 75) return 5;
  if (rank >= 76 && rank <= 208) return 3;
  return 1; // 209–558
}

// Banded passes — rule A is locked; rule B retired (AXIS_BLOCK_B left dead).
const PASSES = {
  1: { lo: 1, hi: 25, out: "ws9-block3-top25-A-v2.csv" },
  2: { lo: 26, hi: 558, out: "ws9-block3-midtail-A.csv" },
};

// Phase 3 targeted re-run: --rerun <comma-ranks> regenerates ONLY those ranks
// and splices them back into their band's output CSV in place (untouched rows
// kept byte-identical). Per-rank de-dup notes are appended to the user message
// for the dishes whose prior version list collided with a standalone catalog
// dish. All targeted ranks live in band 2 (midtail).
// Phase 4 slash-split generation. Keyed by NEW (post-renumber) rank. Each note
// names the former slash-partner so the model commits to a single identity.
const PHASE4_PARTNER = {
  231: "Potstickers", 232: "Dumplings",
  253: "Grilled Porterhouse Steak", 254: "Grilled T-Bone Steak",
  312: "Salmon Croquettes", 313: "Salmon Patties",
  417: "Gourmet Burger", 418: "Pub Burger",
};
function phase4Note(rank) {
  const other = PHASE4_PARTNER[rank];
  return other
    ? `Note: this dish is distinct from its former slash-partner (${other}), which is a separate catalog entry. Commit to this dish's own identity.`
    : undefined;
}

const RERUN_OUT = "ws9-block3-midtail-A.csv";
const RERUN_NOTES = {
  43: "Note: Chicken Tikka Masala is a separate catalog dish and must NOT appear as a version here. Vary this dish along its own axis — e.g. red/green/yellow curry styles, served over rice, or with vegetables.",
  199: "Note: Chana Masala is a separate catalog dish and must NOT appear as a version here.",
  207: "Note: Drunken Noodles (pad kee mao) is a distinct dish from Pad See Ew — it is spicy, with holy basil and chili. Pad See Ew (sweet soy, no heat) is a separate catalog dish at another rank and must NOT appear as a version here.",
};

// ── CSV parse (quote-honoring — reused verbatim from ws9-block3-gen-dishes.cjs) ─
function parseLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ── CSV emit — quote any field containing comma, quote, or newline ────────────
function csvField(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(fields) {
  return fields.map(csvField).join(",");
}

// Windows can briefly EBUSY/EPERM a file an editor/watcher has open. Write to a
// sibling temp file, then rename over the target, retrying the rename a few
// times with a short synchronous backoff.
function writeFileResilient(dest, contents) {
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, contents);
  const delaysMs = [0, 200, 500, 1000, 2000];
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) {
      const until = Date.now() + delaysMs[i];
      while (Date.now() < until) { /* busy-wait; no async in this hot path */ }
    }
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      if ((err.code === "EBUSY" || err.code === "EPERM") && i < delaysMs.length - 1) continue;
      throw err;
    }
  }
}

// ── args ─────────────────────────────────────────────────────────────────────
// Rule A is locked (Phase 2). Selector is now --pass 1|2 (banded run).
function parseArgs(argv) {
  const idx = argv.indexOf("--pass");
  if (idx === -1 || idx === argv.length - 1) {
    throw new Error("missing required arg: --pass 1|2");
  }
  const pass = argv[idx + 1];
  if (!PASSES[pass]) {
    throw new Error(`--pass must be 1 or 2, got: ${JSON.stringify(pass)}`);
  }
  return pass;
}

// ── response parse — strip fences defensively, JSON.parse ────────────────────
function parseResponseText(text) {
  let t = text.trim();
  // Strip a leading ```json / ``` fence and trailing ``` if present.
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(t);
}

function extractText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function callOnce(client, system, userMessage) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  return extractText(message);
}

const OUT_HEADER =
  "rank,category,parent_dish,dish,primary_axis,cross_axis_used,axis_note,short_of_target,short_reason";

function loadDishes(CSV) {
  const lines = fs.readFileSync(CSV, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(1).map((line) => {
    const [rank, dish, category] = parseLine(line);
    return { rank: parseInt(rank, 10), dish: dish.trim(), category: category.trim() };
  });
}

// Generate one dish's version-rows. extraNote (optional) is appended to the
// user message verbatim. Returns { ok, lines, parsed, versions, callsMade } or
// { ok:false, failureText, callsMade }.
async function generateDishRows(client, system, row, N, extraNote) {
  const base = `Dish: ${row.dish}\nCategory: ${row.category}\nN: ${N}\n\nProduce the version list for this dish.`;
  const userMessage = extraNote ? base + "\n\n" + extraNote : base;

  let parsed = null;
  let lastRaw = "";
  let callsMade = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await callOnce(client, system, userMessage);
      callsMade++;
    } catch (err) {
      lastRaw = `API_ERROR attempt ${attempt}: ${err && err.message ? err.message : String(err)}`;
      continue;
    }
    lastRaw = raw;
    try {
      parsed = parseResponseText(raw);
      break;
    } catch (perr) {
      parsed = null; // retry once
    }
  }

  if (!parsed) {
    return { ok: false, callsMade, failureText: `[rank ${row.rank}] ${row.dish} — PARSE/CALL FAILED\n${lastRaw}\n---` };
  }

  const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
  const delivered = parsed.delivered_versions;
  const problems = [];
  if (versions.length !== delivered) {
    problems.push(`versions.length (${versions.length}) !== delivered_versions (${delivered})`);
  }
  if (!(delivered <= N)) {
    problems.push(`delivered_versions (${delivered}) > ${N}`);
  }
  if (problems.length > 0) {
    return { ok: false, callsMade, failureText: `[rank ${row.rank}] ${row.dish} — VALIDATION FAILED: ${problems.join("; ")}\n${lastRaw}\n---`, problems };
  }

  const lines = versions.map((v) => csvRow([
    row.rank, row.category, parsed.parent_dish, v.name, parsed.primary_axis,
    v.cross_axis === true, parsed.axis_note, parsed.short_of_target === true, parsed.short_reason || "",
  ]));
  return { ok: true, callsMade, lines, parsed, versions };
}

async function runPass(client, scriptsDir, CSV, system) {
  const pass = parseArgs(process.argv);
  const band = PASSES[pass];
  const OUT = path.join(scriptsDir, band.out);
  const FAIL = path.join(scriptsDir, band.out.replace(/\.csv$/, "-failures.log"));

  const rows = loadDishes(CSV)
    .filter((r) => r.rank >= band.lo && r.rank <= band.hi)
    .sort((a, b) => a.rank - b.rank);

  console.log(`[pass ${pass} · rule A] ${rows.length} dishes (rank ${band.lo}–${band.hi}), model=${MODEL} temp=${TEMPERATURE}`);

  const outRows = [OUT_HEADER];
  const failures = [];
  let calls = 0;

  for (const row of rows) {
    const res = await generateDishRows(client, system, row, tierN(row.rank));
    calls += res.callsMade;
    if (!res.ok) {
      failures.push(res.failureText);
      console.log(`  rank ${row.rank} ${row.dish} — FAILED (logged)`);
      continue;
    }
    outRows.push(...res.lines);
    console.log(`  rank ${row.rank} ${row.dish} — ${res.parsed.primary_axis}, ${res.versions.length} versions${res.parsed.short_of_target ? " (short)" : ""}`);
  }

  writeFileResilient(OUT, outRows.join("\n") + "\n");
  if (failures.length > 0) writeFileResilient(FAIL, failures.join("\n") + "\n");

  console.log(`\n[axis-rule A] done: ${calls} calls, ${outRows.length - 1} version-rows, ${failures.length} failures`);
  console.log(`  → ${path.relative(process.cwd(), OUT)}`);
  if (failures.length > 0) console.log(`  → ${path.relative(process.cwd(), FAIL)}`);
}

// Phase 3: regenerate specific ranks and splice them back into RERUN_OUT in
// place. Untouched rows are copied verbatim (byte-identical); only the targeted
// ranks' contiguous row-blocks are replaced.
async function runRerun(client, scriptsDir, CSV, system) {
  const idx = process.argv.indexOf("--rerun");
  const spec = process.argv[idx + 1];
  if (!spec) throw new Error("--rerun needs a comma-separated rank list");
  const ranks = spec.split(",").map((s) => parseInt(s.trim(), 10));

  const byRank = new Map(loadDishes(CSV).map((d) => [d.rank, d]));
  const OUT = path.join(scriptsDir, RERUN_OUT);
  const FAIL = path.join(scriptsDir, RERUN_OUT.replace(/\.csv$/, "-rerun-failures.log"));

  console.log(`[rerun] ranks ${ranks.join(",")} → ${RERUN_OUT}, model=${MODEL} temp=${TEMPERATURE}`);

  const newLinesByRank = new Map();
  const failures = [];
  let calls = 0;

  for (const rank of ranks) {
    const row = byRank.get(rank);
    if (!row) { failures.push(`[rank ${rank}] NOT FOUND in CSV`); console.log(`  rank ${rank} — NOT FOUND`); continue; }
    const note = RERUN_NOTES[rank];
    const res = await generateDishRows(client, system, row, tierN(rank), note);
    calls += res.callsMade;
    if (!res.ok) { failures.push(res.failureText); console.log(`  rank ${rank} ${row.dish} — FAILED (logged)`); continue; }
    newLinesByRank.set(rank, res.lines);
    console.log(`  rank ${rank} ${row.dish} — ${res.parsed.primary_axis}, ${res.versions.length} versions${res.parsed.short_of_target ? " (short)" : ""}${note ? " [de-dup note]" : ""}`);
  }

  // Splice into the existing output, preserving untouched lines byte-for-byte.
  const orig = fs.readFileSync(OUT, "utf8").split("\n");
  const header = orig[0];
  const dataLines = orig.slice(1).filter((l) => l.length > 0);
  const requested = new Set([...newLinesByRank.keys()]);
  const emitted = new Set();
  const out = [header];
  let replaced = 0, kept = 0;
  for (const line of dataLines) {
    const r = parseInt(parseLine(line)[0], 10);
    if (requested.has(r)) {
      if (!emitted.has(r)) { out.push(...newLinesByRank.get(r)); emitted.add(r); }
      replaced++;
    } else {
      out.push(line);
      kept++;
    }
  }
  // Any requested rank with new rows but no pre-existing block would be dropped
  // by the loop above — surface it rather than silently losing it.
  for (const r of requested) {
    if (!emitted.has(r)) failures.push(`[rank ${r}] had no pre-existing rows in ${RERUN_OUT} — new rows NOT spliced (position unknown)`);
  }

  writeFileResilient(OUT, out.join("\n") + "\n");
  if (failures.length > 0) writeFileResilient(FAIL, failures.join("\n") + "\n");

  console.log(`\n[rerun] done: ${calls} calls, ${requested.size} dishes regenerated, ${replaced} old rows replaced, ${kept} rows kept unchanged, ${failures.length} failures`);
  console.log(`  → ${path.relative(process.cwd(), OUT)}`);
  if (failures.length > 0) console.log(`  → ${path.relative(process.cwd(), FAIL)}`);
}

// Phase 4: generate specific (new-numbering) ranks from the current source and
// dump their output rows to a JSON sidecar. Does NOT splice — the output CSVs
// are rebuilt deterministically by a separate step. Uses phase4Note() partner
// notes. Keeps generation on the identical constants/pipeline as every pass.
async function runEmit(client, scriptsDir, CSV, system) {
  const idx = process.argv.indexOf("--emit");
  const spec = process.argv[idx + 1];
  if (!spec) throw new Error("--emit needs a comma-separated rank list");
  const ranks = spec.split(",").map((s) => parseInt(s.trim(), 10));
  const byRank = new Map(loadDishes(CSV).map((d) => [d.rank, d]));
  const OUTJSON = path.join(scriptsDir, "ws9-phase4-emit.json");

  console.log(`[emit] ranks ${ranks.join(",")}, model=${MODEL} temp=${TEMPERATURE}`);
  const result = {};
  const failures = [];
  let calls = 0;
  for (const rank of ranks) {
    const row = byRank.get(rank);
    if (!row) { failures.push(`rank ${rank} NOT FOUND`); console.log(`  rank ${rank} — NOT FOUND`); continue; }
    const res = await generateDishRows(client, system, row, tierN(rank), phase4Note(rank));
    calls += res.callsMade;
    if (!res.ok) { failures.push(res.failureText); console.log(`  rank ${rank} ${row.dish} — FAILED`); continue; }
    result[rank] = { parent: res.parsed.parent_dish, dish: row.dish, axis: res.parsed.primary_axis, lines: res.lines, versions: res.versions.map((v) => v.name) };
    console.log(`  rank ${rank} ${row.dish} — ${res.parsed.primary_axis}, ${res.versions.length} version(s)`);
  }
  writeFileResilient(OUTJSON, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n[emit] done: ${calls} calls, ${Object.keys(result).length}/${ranks.length} ok, ${failures.length} failures → ${path.basename(OUTJSON)}`);
  if (failures.length) console.log(failures.join("\n"));
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (run with --env-file=.env)");
  const client = new Anthropic({ apiKey });

  const scriptsDir = __dirname;
  const CSV = path.join(scriptsDir, "ws9-block3-target-dishes.csv");
  const system = SHARED_STEER + "\n\n" + AXIS_BLOCK["A"] + "\n\n" + OUTPUT_SCHEMA;

  if (process.argv.includes("--emit")) return runEmit(client, scriptsDir, CSV, system);
  if (process.argv.includes("--rerun")) return runRerun(client, scriptsDir, CSV, system);
  return runPass(client, scriptsDir, CSV, system);
}

main().catch((e) => { console.error(e); process.exit(1); });
