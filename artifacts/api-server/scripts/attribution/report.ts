// SERVER-6 A (ATTR) — WHERE THE SIGNUPS CAME FROM. Read-only: one findMany, no writes.
//
//   node --env-file=.env --import tsx scripts/attribution/report.ts --from 2026-10-20 --to 2026-10-27
//   node --env-file=.env --import tsx scripts/attribution/report.ts --from 2026-10-01 --all          # staff + test accounts too
//   node --env-file=.env --import tsx scripts/attribution/report.ts --from 2026-10-01 --out r.txt    # the printed lines to a UTF-8 file too
//
// One row per day × source × ref × howHeard, with its count, then the totals by each.
// Days are America/New_York calendar days (the signup alert's clock); --from and --to
// are inclusive and default to the last 7 days. "source" is User.signupSource (the
// door), "ref" is signupAttribution.ref, else its utm_source as "utm:<source>", else
// "-"; "howHeard" is the person's own answer, "-" until they give one.
//
// Real accounts only by default (signupAlert REAL_ACCOUNT_WHERE: no @kitchenwizard.ai,
// kiwitester*, @example.com); --all includes them.
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0).

import { writeFileSync } from "node:fs";
import { format } from "node:util";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { REAL_ACCOUNT_WHERE } from "../../src/lib/signupAlert";
import { sanitizeAttribution } from "../../src/lib/signupAttribution";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${name}: a value`); process.exit(2); }
  return v;
};
const outPath = arg("--out");
if (outPath) {
  const printed: string[] = [];
  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => { printed.push(format(...a)); log(...a); };
  process.on("exit", () => writeFileSync(outPath, printed.join("\n") + "\n", "utf8"));
}
const ALL = argv.includes("--all");

const TZ = "America/New_York";
const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const today = dayOf.format(new Date());
const to = arg("--to") ?? today;
const from = arg("--from") ?? dayOf.format(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
if (!DAY.test(from) || !DAY.test(to) || from > to) {
  console.error("--from / --to: YYYY-MM-DD, from ≤ to");
  process.exit(2);
}

const { host, mode } = assertScriptDatabase("attribution/report");
const prisma = new PrismaClient();

function refOf(attribution: unknown): string {
  const a = sanitizeAttribution(attribution);
  if (a?.ref) return a.ref;
  if (a?.utmSource) return `utm:${a.utmSource}`;
  return "-";
}

async function main() {
  // A day either side of the range in UTC, then cut by the New York calendar day.
  const lo = new Date(`${from}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 1);
  const hi = new Date(`${to}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 2);
  const users = await prisma.user.findMany({
    where: { createdAt: { gte: lo, lt: hi }, ...(ALL ? {} : REAL_ACCOUNT_WHERE) },
    select: { createdAt: true, signupSource: true, signupAttribution: true, howHeard: true },
    orderBy: { createdAt: "asc" },
  });

  const rows = new Map<string, { day: string; source: string; ref: string; howHeard: string; n: number }>();
  const totals = { source: new Map<string, number>(), ref: new Map<string, number>(), howHeard: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let n = 0;
  for (const u of users) {
    const day = dayOf.format(u.createdAt);
    if (day < from || day > to) continue;
    const source = u.signupSource ?? "-";
    const ref = refOf(u.signupAttribution);
    const howHeard = u.howHeard ?? "-";
    const key = [day, source, ref, howHeard].join("\u0000");
    const row = rows.get(key) ?? { day, source, ref, howHeard, n: 0 };
    row.n += 1;
    rows.set(key, row);
    bump(totals.source, source);
    bump(totals.ref, ref);
    bump(totals.howHeard, howHeard);
    n += 1;
  }

  console.log(`attribution/report — ${mode} (${host}) — ${from} … ${to} (${TZ}) — ${ALL ? "every account" : "real accounts"}`);
  console.log(`${n} signup(s)\n`);
  const table = [...rows.values()];
  const w = (k: "day" | "source" | "ref" | "howHeard", title: string) => Math.max(title.length, ...table.map((r) => r[k].length));
  const cols = { day: w("day", "day"), source: w("source", "source"), ref: w("ref", "ref"), howHeard: w("howHeard", "howHeard") };
  const line = (d: string, s: string, r: string, h: string, c: string) =>
    `${d.padEnd(cols.day)}  ${s.padEnd(cols.source)}  ${r.padEnd(cols.ref)}  ${h.padEnd(cols.howHeard)}  ${c}`;
  console.log(line("day", "source", "ref", "howHeard", "n"));
  for (const r of table) console.log(line(r.day, r.source, r.ref, r.howHeard, String(r.n)));
  for (const [title, m] of [["source", totals.source], ["ref", totals.ref], ["howHeard", totals.howHeard]] as const) {
    console.log(`\nby ${title}`);
    for (const [k, c] of [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${k}  ${c}`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
