// QA-NIGHT-1 — known-bug matching, grouping, and the morning summary.
//
// summary.md is written to be pasted into chat: one line per reconciler, the
// NEW findings grouped by signature (worst first, one example each with its
// numbers), the known ones by bug id, then spend, time and accounts.
import { RULE_TITLES, type Finding, type RuleId, type RuleResult, type Severity } from "./types";

export interface KnownBug {
  id: string;
  signature: string;
  detail?: string;
  note: string;
  /** "fixed": a finding that still matches is a regression (QA-NIGHT-2 D). Absent: open. */
  status?: "open" | "fixed";
  fixedIn?: string;
}

function matchEntry(f: Finding, known: KnownBug[]): KnownBug | undefined {
  // R3 re-runs R1/R2 after an edit as "R3:<edit>:<their signature>": a known R1/R2 bug is known there too.
  const sigs = [f.signature, f.signature.replace(/^R3:[a-z-]+:(?=R[12]:)/, "")];
  return known.find((k) => sigs.some((s) => new RegExp(k.signature).test(s)) && (!k.detail || new RegExp(k.detail).test(f.detail)));
}

export function matchKnown(f: Finding, known: KnownBug[]): string | undefined {
  return matchEntry(f, known)?.id;
}

/** Marks the finding known, or REGRESSED when its bug is marked fixed: then it is high, whatever its rule said. */
export function applyKnown(f: Finding, known: KnownBug[]): void {
  const k = matchEntry(f, known);
  f.known = k?.id;
  if (k?.status === "fixed") {
    f.regressed = true;
    f.severity = "high";
  }
}

export interface Group {
  signature: string;
  severity: Severity;
  rule: RuleId;
  known?: string;
  regressed?: boolean;
  count: number;
  households: string[];
  example: Finding;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function groupFindings(findings: Finding[]): Group[] {
  const by = new Map<string, Group>();
  for (const f of findings) {
    const key = `${f.signature}|${f.known ?? ""}`;
    const g = by.get(key);
    if (!g) {
      by.set(key, { signature: f.signature, severity: f.severity, rule: f.rule, known: f.known, ...(f.regressed ? { regressed: true } : {}), count: 1, households: [f.household], example: f });
    } else {
      g.count++;
      if (!g.households.includes(f.household)) g.households.push(f.household);
      if (RANK[f.severity] < RANK[g.severity]) {
        g.severity = f.severity;
        g.example = f;
      }
    }
  }
  return [...by.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count || a.signature.localeCompare(b.signature));
}

export interface RunFacts {
  date: string;
  runTag: string;
  households: { id: string; label: string; status: string; usd: number; wallMin: number; paths: Record<string, string> }[];
  skipped: { id: string; reason: string }[];
  spendUsd: number;
  budgetUsd: number;
  spendByPrompt: Record<string, { calls: number; usd: number }>;
  wallMin: number;
  accountsCreated: number;
  accountsDeleted: number;
  accountsLeft: string[];
  bootProof: string;
  ui: string;
  /** "on (--cook-sim)", "on (KIWI_QA_COOK_SIM=1)" or "off" (QA-NIGHT-2 B). */
  cookSim: string;
}

export function ruleTable(results: RuleResult[]): { rule: RuleId; checked: number; failed: number; high: number }[] {
  const rules = Object.keys(RULE_TITLES) as RuleId[];
  return rules.map((rule) => {
    const rs = results.filter((r) => r.rule === rule);
    const fs = results.flatMap((r) => r.findings).filter((f) => f.rule === rule);
    return {
      rule,
      checked: rs.reduce((n, r) => n + r.checked, 0),
      failed: fs.length,
      high: fs.filter((f) => f.severity === "high").length,
    };
  });
}

const n = (x: Record<string, number | string | null> | undefined) =>
  x ? ` [${Object.entries(x).map(([k, v]) => `${k} ${v}`).join(", ")}]` : "";

export function renderSummary(results: RuleResult[], facts: RunFacts): string {
  const all = results.flatMap((r) => r.findings);
  const groups = groupFindings(all);
  const regressed = groups.filter((g) => g.regressed);
  const fresh = groups.filter((g) => !g.known);
  const known = groups.filter((g) => g.known && !g.regressed);
  const L: string[] = [];
  L.push(`# Kiwi night run · ${facts.date} · ${facts.runTag}`);
  L.push("");
  L.push(`Households ${facts.households.map((h) => `${h.id} ${h.status}`).join(" · ")}${facts.skipped.length ? ` · skipped ${facts.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}` : ""}`);
  L.push(`AI spend **$${facts.spendUsd.toFixed(2)}** of $${facts.budgetUsd.toFixed(2)} · run time ${facts.wallMin.toFixed(1)} min · accounts created ${facts.accountsCreated}, deleted ${facts.accountsDeleted}${facts.accountsLeft.length ? `, **LEFT ${facts.accountsLeft.length}**` : ""}`);
  L.push(`Email off: ${facts.bootProof} · UI pass: ${facts.ui}`);
  L.push(`cook-sim: ${facts.cookSim}`);
  L.push("");
  L.push("| rule | checked | failed | high |");
  L.push("|---|---:|---:|---:|");
  for (const r of ruleTable(results)) {
    L.push(`| ${r.rule} ${RULE_TITLES[r.rule]} | ${r.checked} | ${r.failed === 0 ? (r.checked === 0 ? "— (nothing checked)" : "0 ✓") : r.failed} | ${r.high || ""} |`);
  }
  L.push("");
  if (regressed.length > 0) {
    // A bug known.json marks fixed is back: high, and it moves the exit code.
    L.push(`## Regressed (${regressed.length})`);
    for (const g of regressed) {
      L.push(`- **regressed** **${g.known}** · **high** \`${g.signature}\` ×${g.count} (h${g.households.join(", h")}) — ${g.example.detail.slice(0, 260)}${n(g.example.numbers)}`);
    }
    L.push("");
  }
  L.push(`## New (${fresh.length} signature${fresh.length === 1 ? "" : "s"}, ${fresh.reduce((x, g) => x + g.count, 0)} finding${fresh.reduce((x, g) => x + g.count, 0) === 1 ? "" : "s"})`);
  if (fresh.length === 0) L.push("none");
  for (const g of fresh) {
    L.push(`- **${g.severity}** \`${g.signature}\` ×${g.count} (h${g.households.join(", h")}) — ${g.example.detail.slice(0, 260)}${n(g.example.numbers)}`);
  }
  L.push("");
  L.push(`## Known (${known.length})`);
  if (known.length === 0) L.push("none");
  for (const g of known) {
    L.push(`- ${g.known} · ${g.severity} \`${g.signature}\` ×${g.count} (h${g.households.join(", h")}) — ${g.example.detail.slice(0, 160)}`);
  }
  L.push("");
  L.push("## Paths");
  for (const h of facts.households) {
    const bad = Object.entries(h.paths).filter(([, v]) => v !== "ran");
    L.push(`- h${h.id} ${h.label}: $${h.usd.toFixed(2)}, ${h.wallMin.toFixed(1)} min · ${Object.keys(h.paths).length - bad.length}/${Object.keys(h.paths).length} paths ran${bad.length ? ` · ${bad.map(([k, v]) => `${k}: ${v.slice(0, 140)}`).join(" · ")}` : ""}`);
  }
  L.push("");
  L.push(`Spend by prompt: ${Object.entries(facts.spendByPrompt).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => `${k} ${v.calls}× $${v.usd.toFixed(2)}`).join(" · ") || "none"}`);
  return `${L.join("\n")}\n`;
}

/** Exit non-zero when a NEW high-severity finding exists (a regression of a fixed bug is one). */
export function newHigh(results: RuleResult[]): Finding[] {
  return results.flatMap((r) => r.findings).filter((f) => f.severity === "high" && (!f.known || f.regressed));
}

/** QA-NIGHT-2 E — the run's last line: why it exits 1, so a finding does not read as a crash. */
export function resultLine(fresh: Finding[]): string {
  if (fresh.length === 0) return "RESULT: clean";
  const back = fresh.filter((f) => f.regressed).length;
  return `RESULT: ${fresh.length} new high finding(s)${back ? ` (${back} regressed)` : ""} — see summary.md`;
}
