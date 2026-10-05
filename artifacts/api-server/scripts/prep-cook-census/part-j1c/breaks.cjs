// [prepcook] Part J.1c — each fix broken once: apply the break, run the test that guards
// it, quote the first red line, restore the file, and hash the restore against the
// original. Writes out/breaks.txt.
//
//   node scripts/prep-cook-census/part-j1c/breaks.cjs
const fs = require("fs");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
const A = "src/lib/prepWeekAssembly.ts";
const M = "src/lib/prepStepMinutes.ts";
const C = "src/lib/prepComponents.ts";
const T = "src/lib/__tests__/prepWeekJ1c.test.ts";
const TM = "src/lib/__tests__/prepStepMinutes.test.ts";

const BREAKS = [
  { item: "1 shared tub named once", file: A, test: T, pattern: "^1 —",
    from: "      if (group.length === 1) {", to: "      if (group.length >= 1) {" },
  { item: "2 one destination, one sentence", file: A, test: T, pattern: "^2 —",
    from: "  if (one && fold) {", to: "  if (false) {" },
  { item: "2 fold only on read (no double lid)", file: A, test: T, pattern: "^2 —",
    from: "plan.labelKinds ?? new Map(), false)", to: "plan.labelKinds ?? new Map(), true)" },
  { item: "5 fold keeps the code's number", file: A, test: T, pattern: "^5 —",
    from: "if (want !== undefined && said.length > 0 && said.every((q) => q === want)) {", to: "if (want !== undefined) {" },
  { item: "3 single-dish lids by class", file: A, test: T, pattern: "lone items take its class lids",
    from: "      if (sharedTubLabels.has(label)) continue;\n      const p = portions.get(k);", to: "      continue;\n      const p = portions.get(k);" },
  { item: "3 never into an existing vegetables container", file: A, test: T, pattern: "NEVER put into a vegetables",
    from: "        dest = once(`${p.dishId}|prep-plate`, fitDishName(p.dishName, \" prep plate\"));",
    to: "        dest = ownOf(p.dishId, (c) => c.cls === \"B\")[0]?.name ?? once(`${p.dishId}|prep-plate`, fitDishName(p.dishName, \" prep plate\"));" },
  { item: "3 several lone cuts: one prep plate", file: A, test: T, pattern: "several lone cuts",
    from: "        dest = once(`${p.dishId}|prep-plate`, fitDishName(p.dishName, \" prep plate\"));",
    to: "        continue;" },
  { item: "3 a citrus juiced by its note is the juice", file: A, test: T, pattern: "juiced by its NOTE",
    from: " || (CITRUS.test(name) && /\\b(juic\\w*|zest\\w*)\\b/i.test(notes))", to: "" },
  { item: "4 protein timed by its verb", file: M, test: TM, pattern: "Hans's anchor|slowest verb",
    from: "const byVerb = (verbs ?? [])", to: "const byVerb = ([] as string[])" },
  { item: "4 hyphenated weight is not 'pound'", file: C, test: T, pattern: "hyphenated weight",
    from: "[\\d½¼¾⅓⅔⅛⅜⅝⅞][\\s-]?|\\b(?:a|one|two|three|four|half a)[\\s-])\\bpound", to: "[\\d½¼¾⅓⅔⅛⅜⅝⅞]\\s?|\\b(?:a|one|two|three|four|half a)\\s)\\bpound" },
  { item: "3 two lids that keep differently are each named", file: "src/lib/prepStorage.ts", test: T, pattern: "keep differently",
    from: "  if (closes.length === 1 && closes[0].own) return finish(notes[0]);", to: "  if (closes.every((c) => c.own)) return finish([...new Set(notes)].join(\" \"));" },
  { item: "3 the thing garnished is not the garnish", file: A, test: T, pattern: "thing garnished",
    from: ".some((s) => garnishesOf(s).some((g) => proseNames(g, name)));", to: ".some((s) => /\\b(sprinkl\\w+|garnish\\w*|scatter\\w*)\\b/i.test(s) && proseNames(s, name));" },
  { item: "3 lids that keep alike share one sentence", file: "src/lib/prepStorage.ts", test: T, pattern: "keep alike share ONE sentence",
    from: "for (const i of closes.keys()) groups.set(alike[i], [...(groups.get(alike[i]) ?? []), i]);", to: "for (const i of closes.keys()) groups.set(String(i), [i]);" },
  { item: "BUG-354 names fit the wire", file: A, test: T, pattern: "every container name fits",
    from: "    if (name.length > NAME_MAX) {\n      name = name.startsWith", to: "    if (false) {\n      name = name.startsWith" },
];

const out = [];
for (const b of BREAKS) {
  const orig = fs.readFileSync(b.file, "utf8");
  const before = sha(b.file);
  if (!orig.includes(b.from)) { out.push(`!! ${b.item}: break text not found`); continue; }
  fs.writeFileSync(b.file, orig.replace(b.from, b.to));
  const run = spawnSync(process.execPath, ["--env-file=.env", "--import", "tsx", "--test", `--test-name-pattern=${b.pattern}`, b.test], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  fs.writeFileSync(b.file, orig);
  const after = sha(b.file);
  const text = `${run.stdout}\n${run.stderr}`;
  const failed = /ℹ fail [1-9]/.test(text);
  const red = (text.match(/^\s*(?:AssertionError.*|\+ .*|actual: .*)$/m) ?? ["(no assertion line)"])[0].trim();
  const red2 = (text.match(/^\s*\+ (?!actual - expected).*$/m) ?? [""])[0].trim();
  out.push(`${failed ? "RED  " : "GREEN"} ${b.item}\n      ${red}${red2 && red2 !== red ? `\n      ${red2}` : ""}\n      restore ${b.file}: ${before} → ${after} ${before === after ? "(identical)" : "(DIFFERS)"}`);
}
fs.writeFileSync("scripts/prep-cook-census/part-j1c/out/breaks.txt", out.join("\n") + "\n");
console.log(out.join("\n"));
