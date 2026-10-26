// 1.2-NATIVE B — crash reporting (Sentry), and what an event may carry.
//
// Off unless EXPO_PUBLIC_SENTRY_DSN is set, so the code ships before the
// account exists; off on web (the web CSP pins connect-src) and in dev. The
// live wiring is lib/sentry.ts; this file is pure, so it is tested.
//
// No user content in an event: no screenshots, no view hierarchy, no touch,
// UI or console breadcrumbs (a label or a logged server reply can hold a
// recipe, a name, an email); every URL loses its query and fragment (a
// reset-password link carries its token there); emails are masked; messages
// are capped. The user is a SHA-256 of their id, nothing else.

export interface CrashGateInput {
  platform: string;
  dsn: string | undefined;
  isDev: boolean;
  /** The binary carries RNSentry (lib/nativeModules.ts). */
  hasNative: boolean;
}

export function crashReportingEnabled(i: CrashGateInput): boolean {
  return i.platform !== "web" && !i.isDev && i.hasNative && !!i.dsn && i.dsn.trim().length > 0;
}

/** What is hashed for the user id: a fixed prefix, so a bare id in some
 *  other table never hashes to the same value by accident. */
export function crashUserIdInput(userId: string): string {
  return `kiwi-user:${userId}`;
}

/** The longest exception or event message kept. */
export const CRASH_MESSAGE_MAX = 200;

/** A URL without its query string and fragment. Not a URL: unchanged. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Free text (a message, an exception value): URLs scrubbed, emails masked,
 *  capped at CRASH_MESSAGE_MAX. */
export function scrubText(text: string): string {
  const out = text.replace(URL_IN_TEXT, (u) => scrubUrl(u)).replace(EMAIL_IN_TEXT, "[email]");
  return out.length > CRASH_MESSAGE_MAX ? `${out.slice(0, CRASH_MESSAGE_MAX)}…` : out;
}

/** The breadcrumb categories kept. Everything else (console, touch, ui.*,
 *  custom) is dropped. */
export const KEPT_BREADCRUMB_CATEGORIES: readonly string[] = ["navigation", "xhr", "fetch", "app.lifecycle"];

/** The breadcrumb data keys kept, URLs scrubbed. */
const KEPT_BREADCRUMB_DATA = ["url", "from", "to", "method", "status_code"];
const URL_DATA = new Set(["url", "from", "to"]);

export interface BreadcrumbLike {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export function scrubBreadcrumb<B extends BreadcrumbLike>(b: B): B | null {
  if (!b.category || !KEPT_BREADCRUMB_CATEGORIES.includes(b.category)) return null;
  const out: B = { ...b };
  if (out.message !== undefined) out.message = scrubText(out.message);
  if (b.data) {
    const data: Record<string, unknown> = {};
    for (const k of KEPT_BREADCRUMB_DATA) {
      const v = b.data[k];
      if (v === undefined) continue;
      data[k] = URL_DATA.has(k) && typeof v === "string" ? scrubUrl(v) : v;
    }
    out.data = data;
  }
  return out;
}

export interface EventLike {
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  request?: { url?: string };
  breadcrumbs?: BreadcrumbLike[];
  user?: { id?: string | number };
  extra?: unknown;
  server_name?: string;
  contexts?: { device?: { name?: unknown } };
}

export function scrubEvent<E extends EventLike>(event: E): E {
  const out: E = { ...event };
  if (out.message !== undefined) out.message = scrubText(out.message);
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((v) => (v.value === undefined ? v : { ...v, value: scrubText(v.value) })),
    };
  }
  // A request is only ever a URL: no query string, cookies, headers or body.
  if (out.request) out.request = out.request.url ? { url: scrubUrl(out.request.url) } : {};
  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter((b): b is BreadcrumbLike => b !== null);
  }
  // The hashed id, and no IP, email or username.
  if (out.user) out.user = out.user.id ? { id: out.user.id } : {};
  delete out.extra;
  // The phone's name (often its owner's: "Jo's iPhone") can ride either of these.
  delete out.server_name;
  if (out.contexts?.device && "name" in out.contexts.device) {
    const { name: _name, ...device } = out.contexts.device;
    out.contexts = { ...out.contexts, device };
  }
  return out;
}
