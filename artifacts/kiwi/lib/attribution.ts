// CLIENT-3 D (ATTR, client half) — where a web sign-up came from.
//
// On the first load of the web app (app.kitchenwizard.ai) the visitor's link is
// kept for the tab: a creator's `ref`, the campaign's utm_source / utm_medium /
// utm_campaign, and the path they landed on. Every account-creating body
// carries it once as `attribution` (POST /auth/signup, POST /auth/oauth/apple |
// google; the server keeps it on CREATE only, so a returning member's sign-in
// changes nothing). SERVER-6 stores it (lib/signupAttribution.ts): five keys,
// strings, 120 characters each; anything else is dropped there, never a 400.
//
// sessionStorage, like the web session token (lib/auth.ts): per tab, gone with
// the tab. The FIRST load wins: the app's own redirects (/ → /welcome) and every
// later page keep the link the visitor arrived by. Every access is wrapped, the
// `sessionStorage` property read included (private-mode Safari throws on
// access); a throw reads as "no link". Native sends nothing: an app install has
// no landing URL.
//
// Captured at module load of app/_layout.tsx, before the router's first
// redirect can drop the query string.

import { Platform } from "react-native";

export interface SignupAttribution {
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
}

export const ATTRIBUTION_STORAGE_KEY = "kiwi_attribution";
export const ATTRIBUTION_VALUE_MAX = 120;

const PARAMS: readonly (readonly [string, keyof SignupAttribution])[] = [
  ["ref", "ref"],
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
];

function clip(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, ATTRIBUTION_VALUE_MAX).trim();
  return t.length > 0 ? t : undefined;
}

/** The link in a landing URL's query and path. */
export function attributionFromUrl(search: string, pathname: string): SignupAttribution {
  const out: SignupAttribution = {};
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  for (const [param, key] of PARAMS) {
    const v = clip(query.get(param));
    if (v) out[key] = v;
  }
  const path = clip(pathname);
  if (path) out.landingPath = path;
  return out;
}

export interface AttributionEnv {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  location: { search: string; pathname: string } | null;
}

function webEnv(): AttributionEnv {
  if (Platform.OS !== "web") return { storage: null, location: null };
  let storage: AttributionEnv["storage"] = null;
  try {
    storage = globalThis.sessionStorage ?? null;
  } catch {
    storage = null;
  }
  let location: AttributionEnv["location"] = null;
  try {
    const l = (globalThis as { location?: { search: string; pathname: string } }).location;
    location = l ? { search: l.search, pathname: l.pathname } : null;
  } catch {
    location = null;
  }
  return { storage, location };
}

/** Keep this tab's landing link, unless one is kept already. Never throws. */
export function captureAttribution(env: AttributionEnv = webEnv()): void {
  if (!env.storage || !env.location) return;
  try {
    if (env.storage.getItem(ATTRIBUTION_STORAGE_KEY) !== null) return;
    const a = attributionFromUrl(env.location.search, env.location.pathname);
    env.storage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(a));
  } catch {
    // Blocked or full storage: this tab sends no link.
  }
}

/** The kept link for a sign-up body; undefined when there is none. */
export function readAttribution(env: AttributionEnv = webEnv()): SignupAttribution | undefined {
  if (!env.storage) return undefined;
  try {
    const raw = env.storage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: SignupAttribution = {};
    for (const key of ["ref", "utmSource", "utmMedium", "utmCampaign", "landingPath"] as const) {
      const v = clip((parsed as Record<string, unknown>)[key] as string | undefined);
      if (v) out[key] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
