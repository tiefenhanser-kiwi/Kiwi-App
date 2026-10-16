// ─────────────────────────────────────────────────────────────────────────────
// QA-1 — what the two QA-1 specs share: the item ledger, the console catcher,
// an authenticated raw HTTP lane, and a few RNW-shaped selectors.
//
// Not a spec (no `.spec.ts`), so Playwright never runs it on its own.
//
// 🔴 AN ITEM IS A VERDICT, NOT AN ASSERTION. QA-1 is a checklist run before
// Hans's phone pass: one failed item must not hide the twelve after it, so the
// specs record `pass` / `fail` / `cant-automate` with the evidence and carry
// on. A spec throws only when it cannot reach the thing it is meant to measure
// (no sign-in, no fixture), because a verdict scored against a blank page is
// worse than none.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { API_BASE, RUN_DIR, ensureRunDir } from "../src/env";
import { readCreds, redact } from "../src/creds";
import { capture, renderedText, settle } from "../src/screen";

export type Verdict = "pass" | "fail" | "cant-automate";

export interface QaItem {
  item: string;
  title: string;
  verdict: Verdict;
  evidence: string;
  shots: string[];
  /** Whatever the API said, for a failure's write-up. */
  api?: unknown;
}

export class Ledger {
  readonly items: QaItem[] = [];
  readonly consoleErrors: string[] = [];
  constructor(readonly label: string) {}

  record(item: QaItem): void {
    this.items.push(item);
    console.log(`[${this.label}] ${item.item} ${item.verdict.toUpperCase()} — ${redact(item.evidence)}`);
  }

  /** Run one item; an exception is that item's FAIL, never the suite's. */
  async run(
    item: string,
    title: string,
    fn: (shots: string[]) => Promise<{ verdict: Verdict; evidence: string; api?: unknown }>,
  ): Promise<void> {
    const shots: string[] = [];
    try {
      const r = await fn(shots);
      this.record({ item, title, shots, ...r });
    } catch (err) {
      this.record({
        item,
        title,
        shots,
        verdict: "fail",
        evidence: `threw: ${String((err as Error)?.message ?? err).slice(0, 600)}`,
      });
    }
  }

  /** Every /api response at 400 or above, with its body: the console says "500", this says which. */
  readonly apiErrors: { at: string; method: string; url: string; status: number; body: string }[] = [];

  /** pageerror + console.error, verbatim (redacted), for the console items. */
  watch(page: Page): void {
    page.on("pageerror", (e) => this.consoleErrors.push(`pageerror: ${String(e.message)}`));
    page.on("console", (m) => {
      if (m.type() === "error") this.consoleErrors.push(`console.error: ${m.text()} @ ${m.location().url ?? ""}`);
    });
    page.on("response", async (res) => {
      if (res.status() < 400) return;
      let body = "";
      try {
        body = (await res.text()).slice(0, 600);
      } catch {
        /* gone */
      }
      this.apiErrors.push({
        at: new Date().toISOString(),
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        body,
      });
      console.log(`[${this.label}] HTTP ${res.status()} ${res.request().method()} ${res.url()} ${redact(body.slice(0, 300))}`);
    });
  }

  write(extra: Record<string, unknown> = {}): string {
    ensureRunDir();
    const path = join(RUN_DIR, `${this.label}.json`);
    writeFileSync(
      path,
      redact(
        JSON.stringify(
          { label: this.label, items: this.items, consoleErrors: this.consoleErrors, apiErrors: this.apiErrors, ...extra },
          null,
          2,
        ),
      ),
      "utf8",
    );
    return path;
  }
}

/** One named screenshot under out/<run>/<label>/, path pushed to `shots`. */
export async function shot(page: Page, label: string, name: string, shots: string[]): Promise<string[]> {
  const { shot: s, text } = await capture(page, label, name);
  shots.push(s.file);
  return text;
}

// ── the raw HTTP lane ────────────────────────────────────────────────────────
//
// `src/api.ts`'s Api covers the flow's calls; QA-1 reads routes it has no
// method for (cookbook, makeAhead, prep structure, completions). Same origin as
// the browser, same token the browser holds.

export class Http {
  constructor(private token: string) {}

  static async login(): Promise<{ http: Http; userId: string }> {
    const { email, password } = readCreds();
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`login → ${res.status}`);
    const body = (await res.json()) as { authToken: string; user: { id: string } };
    return { http: new Http(body.authToken), userId: body.user.id };
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* left as text */
    }
    return { status: res.status, body: parsed as T };
  }

  async get<T = any>(path: string): Promise<T> {
    const r = await this.req<T>("GET", path);
    if (r.status >= 400) throw new Error(`GET ${path} → ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }

  /** Every page of GET /plans?filter=my_plans — the app's sheet reads page one only. */
  async allMyPlans(localDate: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ filter: "my_plans", localDate });
      if (cursor) q.set("cursor", cursor);
      const r = await this.get<{ plans: any[]; nextCursor?: string | null }>(`/plans?${q}`);
      out.push(...r.plans);
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }
}

// ── selectors and waits ──────────────────────────────────────────────────────

/** The device's local day, as the app sends it. */
export function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Click the focusable RNW div whose own text is exactly `text`. For the
 * Pressables that carry no role (Chip, FilterChipRow, the Meals | Dishes
 * switch, the sort trigger and its menu) — reported as a friction, not hidden.
 */
export async function clickText(page: Page, text: string | RegExp): Promise<void> {
  const re = typeof text === "string" ? new RegExp(`^\\s*${escapeRe(text)}\\s*$`) : text;
  const loc = page.locator('[tabindex="0"]').filter({ hasText: re });
  await loc.last().waitFor({ state: "visible", timeout: 20_000 });
  await loc.last().click();
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wait for `pred` over the rendered text, polling; returns the last text. */
export async function waitForText(
  page: Page,
  pred: (joined: string) => boolean,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; text: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let text: string[] = [];
  while (Date.now() < deadline) {
    text = await renderedText(page);
    if (pred(text.join("\n"))) return { ok: true, text };
    await page.waitForTimeout(300);
  }
  return { ok: false, text };
}

export { renderedText, settle };

/** "1,325 meals" → 1325. */
export function parseCount(s: string): number | null {
  const m = /([\d,]+)\s+meals?\b/.exec(s);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** The background colour of the focusable div whose text is exactly `label`. */
export async function chipBackground(page: Page, label: string): Promise<string | null> {
  return page.evaluate((l) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]'));
    const el = els.find((e) => (e.innerText || "").trim() === l);
    return el ? getComputedStyle(el).backgroundColor : null;
  }, label);
}

/** Visible elements with role=tab (the bottom tab bar). */
export async function visibleTabCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).filter((e) => {
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    }).length,
  );
}

/** Scroll every scrollable element to its bottom (RNW FlatList is a div). */
export async function scrollAllToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
      const st = getComputedStyle(el);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}
