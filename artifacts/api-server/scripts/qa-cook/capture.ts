// QA-COOK-1 — every Cook Mode sequence through the real routes, as the app shows it.
//
// One account (sign-up + onboarding, like a QA-NIGHT-1 household) on the run's
// own :3100 child. For each servings (2 and 6):
//   • the catalog meals go into plans of up to 7 (POST /plans/from-meals forks a
//     public pick for the account), each item PATCHed to servingsOverride;
//   • unprepped: GET /meals/:id?planItemId (Cook Mode's read from a plan) and,
//     for a multi-dish meal, POST /meals/:id/cooking-sequence { planItemId };
//   • prepped: Prep the Week (POST /plans/:id/prep-week), "Mark all complete"
//     (every step not skipSuggested and not "— cook day", QA-NIGHT-1's
//     tickable()), then the same reads plus what Cook Mode itself loads for the
//     fold: the completions and the week's prep-week payload (a cache hit);
//   • a feast: forkMealForUser (dev has no public Thanksgiving template — QA-7's
//     and QA-NIGHT-1's fixture), its own plan dated Nov 23–29 with the feast on
//     Thursday; prepped = Prep the feast ({ session: "feast" }) ticked in full.
//     Cook Mode then POSTs the WEEK's prep-week (usePrepWeek with no session),
//     exactly as the screen does once a completion exists.
//
// A 429 waits out its Retry-After and repeats the call (the Sequencer allows 12
// a minute); nothing else is retried.
import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { Client, JourneyError, type Reply } from "../qa-night/http";
import { localDate } from "../qa-night/journeys";
import { buildCookView, isMultiDish, type PrepEvidence, type SequenceReply } from "./appView";
import type { SampleMeal } from "./sample";
import type { CookView } from "./types";

const HELD = /— cook day$/;

/** A database read that survives a dropped connection: up to 6 tries, 10 s apart. */
export async function retryDb<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  throw last;
}

export interface CaptureNote {
  meal: string;
  servings: number;
  prepped: boolean;
  note: string;
}

export class CookCapture {
  email: string | null = null;
  userId: string | null = null;
  password = `Qc!${randomBytes(9).toString("base64url")}`;
  readonly notes: CaptureNote[] = [];
  readonly planIds: string[] = [];

  constructor(
    readonly api: Client,
    readonly prisma: PrismaClient,
    readonly runTag: string,
  ) {}

  /** A call that waits out a 429 (Retry-After) and repeats; any other status is returned. */
  async call<T = any>(method: string, path: string, body?: unknown, expect: number[] = []): Promise<Reply<T>> {
    for (let i = 0; i < 8; i++) {
      const r = await this.api.req<T>(method, path, body, { expect: [...expect, 429] });
      if (r.status !== 429) return r;
      await new Promise((res) => setTimeout(res, 6000));
    }
    throw new JourneyError(`${method} ${path}: still 429 after 8 waits`);
  }

  async must<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new JourneyError(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }

  async signUp(): Promise<void> {
    this.api.at("sign up");
    const email = `qa-cook-${this.runTag}-${randomBytes(3).toString("hex")}@example.com`;
    this.email = email;
    const r = await this.must<any>("POST", "/auth/signup", {
      email, password: this.password, firstName: "Qa", lastName: "Cook", platform: "web",
      attribution: { ref: "qa-cook", utmSource: "qa", utmMedium: "cook-sim", utmCampaign: this.runTag, landingPath: "/" },
    });
    this.api.token = r.authToken;
    this.userId = r.user.id;
    await this.must("PATCH", "/me/preferences", {
      householdSize: 4, kidsCount: 0, pickyEaterCount: 0, eatingStyles: [], allergiesAndAvoidances: [], cuisines: ["Italian", "Mexican", "Asian"],
    });
    await this.must("PATCH", "/me/profile", { onboardingComplete: true });
  }

  async deleteAccount(): Promise<{ status: number | null; meAfter: number | null; rowGone: boolean | null }> {
    if (!this.api.token || !this.userId) return { status: null, meAfter: null, rowGone: null };
    this.api.at("delete account");
    const old = this.api.token;
    const d = await this.api.req("DELETE", "/me", { confirm: "delete", currentPassword: this.password });
    const me = await this.api.req("GET", "/auth/me", undefined, { expect: [401], token: old });
    const row = await retryDb(() => this.prisma.user.findUnique({ where: { id: this.userId! }, select: { id: true } }));
    return { status: d.status, meAfter: me.status, rowGone: row === null };
  }

  /**
   * A run that died (a dropped connection) leaves its account, and its password
   * lived only in that run's memory. Sweep every `qa-cook-…@example.com` account
   * through the routes, as QA-7's purge did: a password-reset token signed the
   * way /auth/password-reset/request signs one, confirm, log in, DELETE /me — on
   * this run's own server, whose mail switches are proven off. Returns the
   * addresses and what happened to each.
   */
  async sweepLeftovers(): Promise<string[]> {
    const left = await retryDb(() => this.prisma.user.findMany({ where: { email: { startsWith: "qa-cook-", endsWith: "@example.com" } }, select: { id: true, email: true } }));
    const out: string[] = [];
    if (left.length === 0) return out;
    const { signToken } = await import("../../src/lib/auth");
    this.api.at("sweep leftovers");
    for (const u of left) {
      if (u.id === this.userId) continue;
      const password = `Qc!${randomBytes(9).toString("base64url")}`;
      const reset = await this.api.req("POST", "/auth/password-reset/confirm", { token: signToken(u.id, { purpose: "password_reset", expiresIn: "1h" }), newPassword: password }, { token: null });
      const login = await this.api.req<any>("POST", "/auth/login", { email: u.email, password }, { token: null });
      const del = login.body?.authToken ? await this.api.req("DELETE", "/me", { confirm: "delete", currentPassword: password }, { token: login.body.authToken }) : { status: 0 };
      const gone = (await retryDb(() => this.prisma.user.findUnique({ where: { id: u.id }, select: { id: true } }))) === null;
      out.push(`${u.email}: reset ${reset.status} · login ${login.status} · DELETE /me ${del.status} · row ${gone ? "gone" : "STILL THERE"}`);
    }
    return out;
  }

  // ── plans ────────────────────────────────────────────────────────────────

  /** A plan of these meals at `servings`; returns each sample meal's plan item. */
  async planOf(meals: SampleMeal[], servings: number, mealIds?: string[]): Promise<{ planId: string; items: Map<string, { planItemId: string; mealId: string }> }> {
    const made = await this.must<any>("POST", "/plans/from-meals", {
      mealIds: mealIds ?? meals.map((m) => m.id), planDurationDays: 7, householdSize: servings, localDate: localDate(),
    });
    const planId: string = made.planId ?? made.instance?.id;
    this.planIds.push(planId);
    const plan = (await this.must<any>("GET", `/plans/${planId}`)).plan;
    const items = new Map<string, { planItemId: string; mealId: string }>();
    // from-meals forks a public pick: map back by title (the sample has one meal per title).
    const titles = new Map(
      (await retryDb(() => this.prisma.meal.findMany({ where: { id: { in: (plan.items as any[]).map((x) => x.mealId) } }, select: { id: true, title: true } }))).map((x) => [x.id, x.title.trim().toLowerCase()]),
    );
    const used = new Set<string>();
    for (const m of meals) {
      const want = m.title.trim().toLowerCase();
      const pick = (plan.items as any[]).find((x) => !used.has(x.id) && (mealIds ? mealIds.includes(x.mealId) : titles.get(x.mealId) === want));
      if (!pick) throw new JourneyError(`plan ${planId.slice(0, 8)} has no item for "${m.title}"`);
      used.add(pick.id);
      items.set(m.id, { planItemId: pick.id, mealId: pick.mealId });
      await this.must("PATCH", `/plans/${planId}/items/${pick.id}`, { servingsOverride: servings });
    }
    return { planId, items };
  }

  /** Cook Mode's reads for one plan item. */
  async cookRead(item: { planItemId: string; mealId: string }, sample: SampleMeal, servings: number, prep: PrepEvidence | null): Promise<CookView> {
    const meal = (await this.must<any>("GET", `/meals/${item.mealId}?planItemId=${item.planItemId}`)).meal;
    let sequence: SequenceReply | null = null;
    if (isMultiDish(meal)) {
      const r = await this.call<SequenceReply>("POST", `/meals/${item.mealId}/cooking-sequence`, { planItemId: item.planItemId });
      if (r.status === 200) sequence = r.body;
      else this.notes.push({ meal: sample.title, servings, prepped: !!prep, note: `cooking-sequence → ${r.status}: naive order (the screen's fallback)` });
    }
    return buildCookView({ meal, sequence, prep, sourceMealId: sample.id, category: sample.category, servings });
  }

  /** Prep the Week (or Prep the feast), then "Mark all complete". */
  async prepAndTick(planId: string, body?: { session: "feast" }): Promise<{ steps: number; ticked: number }> {
    const r = await this.call<any>("POST", `/plans/${planId}/prep-week`, body);
    if (r.status !== 200) throw new JourneyError(`prep-week ${JSON.stringify(body ?? {})} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const steps = (r.body.result.phases as any[]).flatMap((p) => p.steps as any[]);
    const keys = body?.session ? steps.map((s) => s.stepKey) : steps.filter((s) => !s.skipSuggested && !HELD.test(s.title)).map((s) => s.stepKey);
    for (const k of keys) await this.must("PUT", `/plans/${planId}/prep-week/completions`, { stepKey: k });
    return { steps: steps.length, ticked: keys.length };
  }

  /** What Cook Mode loads for the fold once a completion exists: completions + the week's payload. */
  async cookPrepEvidence(planId: string): Promise<PrepEvidence | null> {
    const c = await this.must<any>("GET", `/plans/${planId}/prep-week/completions`);
    const completions = (c.completions as { stepKey: string; checkedAt: string }[]) ?? [];
    if (completions.length === 0) return null;
    const w = await this.call<any>("POST", `/plans/${planId}/prep-week`, undefined, [400, 404, 409, 422, 502]);
    return { result: w.status === 200 ? w.body.result : undefined, checked: completions.map((x) => x.stepKey), completions };
  }

  // ── the passes ───────────────────────────────────────────────────────────

  /** Catalog meals at one servings: unprepped views, then the week prepped, then prepped views. */
  async catalogPass(meals: SampleMeal[], servings: number, onView: (v: CookView) => void, have: (mealId: string, servings: number) => boolean = () => false): Promise<void> {
    for (let i = 0; i < meals.length; i += 7) {
      const group = meals.slice(i, i + 7);
      // Resume: a plan whose meals were all captured (unprepped and prepped) by an earlier run is skipped.
      if (group.every((m) => have(m.id, servings))) continue;
      this.api.at(`catalog ${servings}p plan ${i / 7 + 1}`);
      const { planId, items } = await this.planOf(group, servings);
      for (const m of group) onView(await this.cookRead(items.get(m.id)!, m, servings, null));
      this.api.at(`catalog ${servings}p prep ${i / 7 + 1}`);
      const t = await this.prepAndTick(planId);
      this.notes.push({ meal: `plan of ${group.length}`, servings, prepped: true, note: `Prep the Week: ${t.steps} steps, ${t.ticked} ticked` });
      const prep = await this.cookPrepEvidence(planId);
      for (const m of group) onView(await this.cookRead(items.get(m.id)!, m, servings, prep));
    }
  }

  /** A feast at one servings: fork, its own plan (Thanksgiving week, Thursday), unprepped, Prep the feast, prepped. */
  async feastPass(feast: SampleMeal, servings: number, onView: (v: CookView) => void): Promise<void> {
    this.api.at(`feast ${servings}p ${feast.title.slice(0, 20)}`);
    const { forkMealForUser } = await import("../../src/lib/mealFork");
    const { mealId } = await retryDb(() => this.prisma.$transaction((tx) => forkMealForUser(tx as never, feast.id, this.userId!), { timeout: 60_000, maxWait: 10_000 }));
    const { planId, items } = await this.planOf([feast], servings, [mealId]);
    await this.must("PATCH", `/plans/${planId}`, { startDate: "2026-11-23", endDate: "2026-11-29", localDate: localDate() });
    const it = items.get(feast.id)!;
    await this.must("PATCH", `/plans/${planId}/items/${it.planItemId}`, { assignedDayOfWeek: "Thursday" });
    onView(await this.cookRead(it, feast, servings, null));
    const t = await this.prepAndTick(planId, { session: "feast" });
    this.notes.push({ meal: feast.title, servings, prepped: true, note: `Prep the feast: ${t.steps} steps, ${t.ticked} ticked` });
    const prep = await this.cookPrepEvidence(planId);
    if (prep && !prep.result) this.notes.push({ meal: feast.title, servings, prepped: true, note: "Cook Mode's week prep-week read did not return 200: no fold (chips only)" });
    onView(await this.cookRead(it, feast, servings, prep));
  }
}
