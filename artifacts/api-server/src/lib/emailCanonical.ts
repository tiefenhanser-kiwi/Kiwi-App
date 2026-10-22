// SEC-2 #16 — ONE FREE TRIAL PER PERSON.
//
// Hans, October 21: "if I sign up for 2 weeks with hans.tiefenthaler@gmail.com
// and then sign up with hans.tiefenthaler+1@gmail.com and so on." Every one of
// those addresses lands in the same inbox, and every one of them used to get a
// fresh 14-day trial. The canonical form is the address with the parts that do
// not name a different inbox taken off; two accounts with the same canonical
// email are one person as far as the trial is concerned.
//
// The account is still CREATED — refusing a sign-up would tell a stranger that
// the address (or an alias of it) already has an account, which is exactly the
// enumeration SEC-2 #13 closed elsewhere. It simply starts without a trial.
//
// ⚠️ THE MIGRATION'S BACKFILL IS THIS FUNCTION IN SQL
// (prisma/migrations/20261021200000_sec2_email_canonical). Change one, change
// both — sec2EmailCanonical.test.ts pins the cases they must agree on.

/**
 * Lower-cased and trimmed; split at the LAST "@" (an address with no "@", or
 * with it first, is returned as is); a "+tag" dropped from the local part
 * unless that would empty it; googlemail.com unified to gmail.com; and for
 * gmail.com the dots dropped from the local part unless that would empty it.
 */
export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const untagged = local.split("+")[0]!;
  if (untagged !== "") local = untagged;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const undotted = local.replace(/\./g, "");
    if (undotted !== "") local = undotted;
  }
  return `${local}@${domain}`;
}

export const ENV_TRIAL_DUPLICATE_EXEMPT = "TRIAL_DUPLICATE_EXEMPT";
const DEFAULT_TRIAL_DUPLICATE_EXEMPT = "kitchenwizard.ai";

/**
 * The exemption list: comma-separated domains ("kitchenwizard.ai") or
 * addresses ("hans.tiefenthaler@gmail.com"). Unset means the default, the
 * team's own domain; SET TO EMPTY means nobody is exempt. Read per call, so a
 * Cloud Run env change takes effect on the new revision with no code change.
 */
export function readTrialDuplicateExempt(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ENV_TRIAL_DUPLICATE_EXEMPT] ?? DEFAULT_TRIAL_DUPLICATE_EXEMPT;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

/**
 * True when this address may hold more than one trial. A DOMAIN entry matches
 * that domain and its subdomains; an ADDRESS entry matches by canonical form,
 * so exempting "hans.tiefenthaler@gmail.com" also exempts every "+1", "+2"
 * alias of it — which is exactly what test aliases are.
 */
export function isTrialDuplicateExempt(email: string, entries: readonly string[]): boolean {
  const canonical = canonicalEmail(email);
  const domain = canonical.slice(canonical.lastIndexOf("@") + 1);
  return entries.some((entry) =>
    entry.includes("@")
      ? canonicalEmail(entry) === canonical
      : domain === entry || domain.endsWith(`.${entry}`),
  );
}

/** Subscription.trialDeniedReason for an account whose inbox already had a trial. */
export const TRIAL_ALREADY_USED = "trial_already_used";

/** What the client shows. Kept here so the 402 and the signup shape say the same thing. */
export const TRIAL_ALREADY_USED_MESSAGE = "Your free trial was already used with this email.";
