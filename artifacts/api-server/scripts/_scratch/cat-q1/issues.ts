// CAT-Q1 — the issues CAT-Q0 found, read verbatim from out/catq0-full.csv
// (production's reviews), plus the sets this lane works in. Pure file reads.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const Q0_OUT = join(HERE, "..", "cat-q0", "out");
export const OUT = join(HERE, "out");

/** The prisma/seed.ts rows that are public on production with no steps (Part A). */
export const SEED_IDS = [
  "r-buddha", "r-curry", "r-grain-bowl", "r-greek", "r-pasta", "r-pizza",
  "r-salmon", "r-shrimp", "r-stew", "r-stirfry", "r-tacos", "r-tofu",
] as const;
export const isSeedId = (id: string) => (SEED_IDS as readonly string[]).includes(id);

export interface Q0Issue {
  /** 1-based within the meal's block+fix list, in CSV order: the number the editor cites. */
  n: number;
  mealId: string;
  title: string;
  verdict: string;
  featured: string;
  class: number;
  severity: "block" | "fix" | "polish";
  dish: string;
  /** e.g. `ingredient "1 cup rice" · step 3` */
  where: string;
  quote: string;
  why: string;
  fix: string;
  /** Parsed from `where`. */
  ingredient: string | null;
  stepIndex: number | null;
}

/** RFC-4180 rows (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseWhere(where: string): { ingredient: string | null; stepIndex: number | null } {
  const ing = where.match(/ingredient "(.*)"(?: · step \d+)?$/);
  const step = where.match(/(?:^|· )step (\d+)$/);
  return { ingredient: ing ? ing[1] : null, stepIndex: step ? Number(step[1]) : null };
}

/** Every block and fix issue, grouped by meal, numbered per meal. Polish is out (§1). */
export function readIssues(file = join(Q0_OUT, "catq0-full.csv")): Map<string, Q0Issue[]> {
  const [head, ...rows] = parseCsv(readFileSync(file, "utf8"));
  const col = (k: string) => head.indexOf(k);
  const out = new Map<string, Q0Issue[]>();
  for (const r of rows) {
    if (r.length < head.length) continue;
    const severity = r[col("severity")] as Q0Issue["severity"];
    if (severity !== "block" && severity !== "fix") continue;
    const mealId = r[col("mealId")];
    const list = out.get(mealId) ?? [];
    const where = r[col("where")];
    list.push({
      n: list.length + 1, mealId, title: r[col("title")], verdict: r[col("verdict")], featured: r[col("featured")],
      class: Number(r[col("class")]), severity, dish: r[col("dish")], where, quote: r[col("quote")], why: r[col("why")], fix: r[col("fix")],
      ...parseWhere(where),
    });
    out.set(mealId, list);
  }
  return out;
}

interface CatFile { featuredPlans: Array<{ templateId: string; mealIds: string[] }> }
export function featuredIds(): string[] {
  const cat = JSON.parse(readFileSync(join(Q0_OUT, "prod-catalog.json"), "utf8")) as CatFile;
  return [...new Set(cat.featuredPlans.flatMap((t) => t.mealIds))];
}

/** §2: the 25 Featured meals plus the non-seed blocks. */
export function pilotIds(issues: Map<string, Q0Issue[]>): string[] {
  const blocks = [...issues.entries()].filter(([id, xs]) => !isSeedId(id) && xs.some((x) => x.severity === "block")).map(([id]) => id);
  return [...new Set([...featuredIds(), ...blocks])];
}

/** §2: everything else with a fix or block (seed rows are Part A's). */
export function restIds(issues: Map<string, Q0Issue[]>): string[] {
  const pilot = new Set(pilotIds(issues));
  return [...issues.keys()].filter((id) => !isSeedId(id) && !pilot.has(id)).sort();
}

export function prodReviewKeys(): Map<string, string> {
  const cat = JSON.parse(readFileSync(join(Q0_OUT, "prod-catalog.json"), "utf8")) as { catalog: Array<{ id: string; reviewKey: string }> };
  return new Map(cat.catalog.map((c) => [c.id, c.reviewKey]));
}
