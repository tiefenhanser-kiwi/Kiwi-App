// ─────────────────────────────────────────────────────────────────────────────
// results.json — one file per run folder, with every rule check's pass/fail and
// the offending text.
//
// The format is chosen for the reader in §1's gate: chat-Claude reads the rule
// output and the screenshots, and Hans tests only the judgement items. So every
// entry carries the text that failed, not a rule id and a count, and a rule
// with no candidates is `pass: null` rather than a green tick nothing earned.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { RUN_DIR, ensureRunDir } from "./env";
import { redact } from "./creds";
import type { RuleResult } from "./renderRules";
import type { GroceryCheckResult, PrepCookCheckResult } from "./censusBridge";
import type { SurfaceSpend } from "./spend";
import type { Shot } from "./screen";
import { apiLog } from "./api";

export interface FlowResult {
  run: number;
  note: string;
  mealIds: string[];
  planId: string | null;
  planName: string | null;
  listId: string | null;
  ok: boolean;
  error: string | null;
  wallMs: number;
  screens: Shot[];
  /** The browser's own rules + the screen-reached gates. */
  browserRules: RuleResult[];
  /** The grocery census checker's verdict, run unmodified. */
  grocery: GroceryCheckResult | null;
  /** The prep-cook census checker's verdict, run unmodified. */
  prepCook: PrepCookCheckResult | null;
  spend: SurfaceSpend[];
  /** Everything that fought the harness, per run. */
  frictions: string[];
}

export interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  preflight: { name: string; ok: boolean; note: string }[];
  flows: FlowResult[];
  totals: {
    flows: number;
    flowsOk: number;
    costUsd: number;
    groceryFindings: Record<string, number>;
    prepCookFindings: Record<string, number>;
    browserRuleFailures: number;
  };
  apiCalls: { method: string; path: string; status: number; ms: number }[];
}

export function writeResults(file: RunFile): string {
  ensureRunDir();
  const path = join(RUN_DIR, "results.json");
  // redact() before write: the flow's own error strings can quote a request
  // body, and a request body on this account carries the password.
  writeFileSync(path, redact(JSON.stringify(file, null, 2)), "utf8");
  return path;
}

export function totalsOf(flows: FlowResult[]): RunFile["totals"] {
  const groceryFindings: Record<string, number> = {};
  const prepCookFindings: Record<string, number> = {};
  let costUsd = 0;
  let browserRuleFailures = 0;
  for (const f of flows) {
    for (const s of f.spend) costUsd += s.costUsd;
    for (const [k, v] of Object.entries(f.grocery?.totals ?? {})) {
      groceryFindings[k] = (groceryFindings[k] ?? 0) + v;
    }
    for (const x of f.prepCook?.findings ?? []) {
      prepCookFindings[x.rule] = (prepCookFindings[x.rule] ?? 0) + 1;
    }
    browserRuleFailures += f.browserRules.filter((r) => r.pass === false).length;
  }
  return {
    flows: flows.length,
    flowsOk: flows.filter((f) => f.ok).length,
    costUsd: Number(costUsd.toFixed(6)),
    groceryFindings,
    prepCookFindings,
    browserRuleFailures,
  };
}

export function snapshotApiLog(): RunFile["apiCalls"] {
  return apiLog.map((c) => ({ ...c }));
}
