// R3-0 — the one database guard for the data scripts the production runbook
// (scripts/grocery-release/README.md) runs.
//
// Two ways through, and only two:
//   dev         the DATABASE_URL host contains "ep-broad-haze" (the Neon dev
//               branch) — the rule every script carried inline before this.
//   production  KIWI_PRODUCTION_HOST is set AND equals the DATABASE_URL
//               hostname exactly (full string, case-sensitive). The operator
//               has to type the production hostname into the environment, so
//               it cannot be satisfied by a default, a stale .env or a
//               sub-string. One stderr line says it happened.
// Anything else throws. The messages carry hostnames only — never the URL,
// never credentials.

export type ScriptDatabaseMode = "dev" | "production";

export const DEV_HOST_MARKER = "ep-broad-haze";
export const PRODUCTION_HOST_ENV = "KIWI_PRODUCTION_HOST";

function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

/** The override as it may be quoted back: a hostname, or a refusal to echo
 *  something that looks like a URL (which could carry a password). */
function quotableOverride(v: string): string {
  return /[:/@]/.test(v) ? "<not a bare hostname — not echoed>" : `"${v}"`;
}

export function assertScriptDatabase(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): { host: string; mode: ScriptDatabaseMode } {
  const host = hostnameOf(env.DATABASE_URL);
  if (host.includes(DEV_HOST_MARKER)) return { host, mode: "dev" };

  const override = env[PRODUCTION_HOST_ENV];
  if (override && override === host) {
    log(`${label}: PRODUCTION host ${host} (${PRODUCTION_HOST_ENV} matched)`);
    return { host, mode: "production" };
  }

  const base = `refusing: DATABASE_URL host "${host}" is not the dev branch and ${PRODUCTION_HOST_ENV} does not name it`;
  throw new Error(override ? `${base} (${PRODUCTION_HOST_ENV} is ${quotableOverride(override)})` : base);
}
