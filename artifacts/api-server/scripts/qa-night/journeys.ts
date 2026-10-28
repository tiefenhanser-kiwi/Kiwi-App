// QA-NIGHT-1 — one household, start to finish, through the real API on :3100.
//
// Every request is one the app makes (the file:line it mirrors is noted where
// the shape is not obvious). The ONE exception is the feast households' meal:
// dev has no public Thanksgiving template or meal (the THX meals are private
// prod-copies), so the run forks one for the new account with the server's own
// forkMealForUser, exactly as QA-7's / SERVER-7's fixtures did — and then builds
// the plan, dates it, picks the day and the weight through the routes.
//
// A path that cannot continue throws JourneyError; it is recorded on the
// household and the household moves on to the paths that do not depend on it.
// The account is deleted whatever happened.
import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { Client, JourneyError } from "./http";
import {
  cookKey,
  type CookRef,
  type MakeAheadRow,
  type PrepToCookMeal,
  reconcileR4,
  reconcileR5,
  reconcileR6,
  reconcileR7,
  reconcileR8,
  reconcileR9,
  type SequencedStep,
} from "./reconcilePrepCook";
import { type GroceryEvidence, reconcileR1, reconcileR2, reconcileR3 } from "./reconcileGrocery";
import type { GroceryRow, PlanMeal, PrepSession, PrepStep, RecipeStep, RuleResult } from "./types";

export interface HouseholdSpec {
  id: string;
  label: string;
  size: number;
  kids?: number;
  picky?: number;
  howHeard: string | null;
  prefs: {
    eatingStyles?: string[];
    allergiesAndAvoidances?: string[];
    spiceTolerance?: string;
    pickyAvoidances?: string[];
  };
  plan:
    | { kind: "template"; template: string }
    | { kind: "ai"; days: number }
    | { kind: "guest"; days: number }
    | { kind: "feast"; source: string; name: string; day: string; birdWeightLb: number | null };
  edits: ("swap" | "servings" | "add-dish" | "bird-weight")[];
  prep: ("full" | "partial" | "subset" | "one-meal" | "recipes-yes" | "feast")[];
  estimateUsd: number;
}

export interface HouseholdOutcome {
  id: string;
  label: string;
  email: string | null;
  userId: string | null;
  guestSessionId: string | null;
  planId: string | null;
  results: RuleResult[];
  /** path → "ran" | "skipped: …" | "FAILED: …" */
  paths: Record<string, string>;
  ticksPut: Record<string, number>;
  finishesRecorded: number;
  deleted: { status: number | null; meAfter: number | null; rowGone: boolean | null };
  wallMs: number;
  /** Raw evidence, for the morning reader (written to the run folder). */
  evidence: Record<string, unknown>;
}

const UI_TAG = "qa-night";

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}


export class Household {
  readonly out: HouseholdOutcome;
  password = `Qn!${randomBytes(9).toString("base64url")}`;
  meals: PlanMeal[] = [];
  /** cook step (dishId#idx) → its unprepped read, per meal. */
  baseline = new Map<string, Record<string, RecipeStep>>();
  week: PrepSession | null = null;
  ticked = new Set<string>();
  /** mealId → the card's minutes (GET /meals/:id `minutes`), for R8's time check. */
  cards = new Map<string, number>();

  constructor(
    readonly spec: HouseholdSpec,
    readonly runTag: string,
    readonly api: Client,
    readonly prisma: PrismaClient,
  ) {
    this.out = {
      id: spec.id, label: spec.label, email: null, userId: null, guestSessionId: null, planId: null,
      results: [], paths: {}, ticksPut: {}, finishesRecorded: 0,
      deleted: { status: null, meAfter: null, rowGone: null }, wallMs: 0, evidence: {},
    };
  }

  get planId(): string {
    if (!this.out.planId) throw new JourneyError("no plan");
    return this.out.planId;
  }

  push(r: RuleResult) {
    this.out.results.push(r);
  }

  /** Run one path; a failure is recorded and the household continues. */
  async path(name: string, fn: () => Promise<void>): Promise<boolean> {
    this.api.at(name);
    try {
      await fn();
      this.out.paths[name] ??= "ran";
      return true;
    } catch (e) {
      this.out.paths[name] = `FAILED: ${String((e as Error).message ?? e).slice(0, 300)}`;
      return false;
    }
  }

  // ── 1. sign up, how-heard, onboarding ─────────────────────────────────────

  async signUp(): Promise<void> {
    const s = this.spec;
    const email = `${UI_TAG}-${this.runTag}-h${s.id}-${randomBytes(3).toString("hex")}@example.com`;
    this.out.email = email;
    let guest: { guestSessionId: string; token: string } | null = null;
    if (s.plan.kind === "guest") guest = await this.guestPlan(s.plan.days);
    const r = await this.api.must<any>("POST", "/auth/signup", {
      email, password: this.password, firstName: "Qa", lastName: `Night${s.id}`, platform: "web",
      attribution: { ref: "qa-night", utmSource: "qa", utmMedium: "night", utmCampaign: this.runTag, landingPath: "/" },
      ...(guest ? { guestSessionId: guest.guestSessionId, guestToken: guest.token, localDate: localDate() } : {}),
    });
    this.api.token = r.authToken;
    this.out.userId = r.user.id;
    if (guest) {
      if (!r.claimedPlanId) throw new JourneyError(`guest claim returned no plan (claimRetryable ${r.claimRetryable})`);
      this.out.planId = r.claimedPlanId;
      this.out.evidence.claim = { claimedPlanId: r.claimedPlanId, onboardingRequired: r.onboardingRequired };
    }
    // How did you hear (app/how-heard.tsx): an answer is one PATCH; Skip sends nothing.
    if (s.howHeard) {
      await this.api.must("PATCH", "/me/profile", s.howHeard === "creator" ? { howHeard: "creator", howHeardDetail: "qa night" } : { howHeard: s.howHeard });
    }
    if (guest) return; // the claim copies the guest's answers and finishes onboarding
    // Onboarding (onboarding-step-3.tsx buildFullPrefs → updateUserPreferences, then completeOnboarding).
    await this.api.must("PATCH", "/me/preferences", {
      householdSize: s.size,
      kidsCount: s.kids ?? 0,
      pickyEaterCount: s.picky ?? 0,
      ...(s.prefs.pickyAvoidances ? { pickyAvoidances: s.prefs.pickyAvoidances } : {}),
      ...(s.prefs.spiceTolerance ? { spiceTolerance: s.prefs.spiceTolerance } : {}),
      eatingStyles: s.prefs.eatingStyles ?? [],
      allergiesAndAvoidances: s.prefs.allergiesAndAvoidances ?? [],
      cuisines: ["Italian", "Mexican", "Asian"],
    });
    await this.api.must("PATCH", "/me/profile", { onboardingComplete: true });
  }

  /** Test Kitchen (lib/api/guest.ts): a session, the shelf, picks → the guest's one plan. No AI. */
  private async guestPlan(days: number): Promise<{ guestSessionId: string; token: string }> {
    const g = await this.api.must<any>("POST", "/guest/session", {});
    this.out.guestSessionId = g.guestSessionId;
    const prefs = {
      planDurationDays: days, householdSize: this.spec.size, cuisines: [], difficulty: "easy",
      weeklyPacing: "mostly_easy", allergiesAndAvoidances: [], eatingStyles: [], maxCookTimeMinutes: null,
    };
    const shelf = await this.api.req<any>("POST", "/wizard/shelf", prefs, { token: g.token });
    if (shelf.status !== 200) throw new JourneyError(`guest shelf → ${shelf.status}`);
    const mealIds = (shelf.body.meals as { id: string }[]).slice(0, days).map((m) => m.id);
    const picks = await this.api.req<any>("POST", "/guest/plan-from-picks", { mealIds, preferences: prefs, localDate: localDate() }, { token: g.token });
    if (picks.status !== 200) throw new JourneyError(`plan-from-picks → ${picks.status} ${JSON.stringify(picks.body).slice(0, 200)}`);
    return { guestSessionId: g.guestSessionId, token: g.token };
  }

  // ── 2. the plan ───────────────────────────────────────────────────────────

  async makePlan(): Promise<void> {
    const p = this.spec.plan;
    if (p.kind === "guest") return; // claimed at sign-up
    if (p.kind === "template") {
      const list = await this.api.must<any>("GET", "/plans?filter=featured");
      const t = (list.plans as { id: string; name: string }[]).find((x) => x.name === p.template);
      if (!t) throw new JourneyError(`no featured template "${p.template}" (have: ${(list.plans as any[]).map((x) => x.name).join(", ")})`);
      const used = await this.api.must<any>("POST", `/plans/use-template/${t.id}`);
      this.out.planId = used.instance.id;
      // "Use this week" (previewUseFlow.ts → AppContext PATCH).
      await this.api.must("PATCH", `/plans/${this.planId}`, { isActiveThisWeek: true, localDate: localDate() });
      return;
    }
    if (p.kind === "ai") {
      // The member wizard (lib/api/wizard.ts): build-plans → expand → activate.
      const input = {
        planDurationDays: p.days, householdSize: this.spec.size, difficulty: "easy", weeklyPacing: "mostly_easy",
        eatingStyles: this.spec.prefs.eatingStyles ?? [], allergiesAndAvoidances: this.spec.prefs.allergiesAndAvoidances ?? [],
      };
      const built = await this.api.must<any>("POST", "/wizard/build-plans", { ...input, another: { dismissedPlanTitles: [] } });
      const candidate = built.candidates?.[0];
      if (!candidate) throw new JourneyError(`build-plans gave no candidate (${built.reason ?? "no reason"})`);
      const ex = await this.api.must<any>("POST", "/wizard/expand", {
        candidate,
        candidateContext: { planDurationDays: p.days, householdSize: this.spec.size, wantsLeftovers: false, difficulty: "easy", eatingStyles: input.eatingStyles, allergiesAndAvoidances: input.allergiesAndAvoidances },
      });
      const act = await this.api.must<any>("POST", `/wizard/drafts/${ex.draft.id}/activate`, { localDate: localDate() });
      this.out.planId = act.instance.id;
      return;
    }
    // The feast (see the header): a fork for this account, then the routes.
    const { forkMealForUser } = await import("../../src/lib/mealFork");
    const { mealId } = await this.prisma.$transaction((tx) => forkMealForUser(tx as never, p.source, this.out.userId!), { timeout: 60_000, maxWait: 10_000 });
    this.out.evidence.feastFork = { source: p.source, mealId, note: "forkMealForUser fixture (dev has no public Thanksgiving template)" };
    const made = await this.api.must<any>("POST", "/plans/from-meals", { mealIds: [mealId], planDurationDays: 7, householdSize: this.spec.size, localDate: localDate() });
    this.out.planId = made.planId ?? made.instance?.id;
    // The date editor: Thanksgiving week, Mon Nov 23 – Sun Nov 29; then the feast's day.
    await this.api.must("PATCH", `/plans/${this.planId}`, { startDate: "2026-11-23", endDate: "2026-11-29", localDate: localDate() });
    const plan = await this.api.must<any>("GET", `/plans/${this.planId}`);
    const item = plan.plan.items[0];
    await this.api.must("PATCH", `/plans/${this.planId}/items/${item.id}`, { assignedDayOfWeek: p.day });
  }

  /** GET /plans/:id, then every item's meal as Cook Mode reads it (with its planItemId). */
  async loadMeals(opts: { prepped?: boolean } = {}): Promise<{ meals: PlanMeal[]; reads: Map<string, Record<string, RecipeStep>>; plan: any }> {
    const plan = (await this.api.must<any>("GET", `/plans/${this.planId}`)).plan;
    const meals: PlanMeal[] = [];
    const reads = new Map<string, Record<string, RecipeStep>>();
    for (const it of plan.items as any[]) {
      const q = `?planItemId=${it.id}${opts.prepped ? "&prepped=1" : ""}`;
      const m = (await this.api.must<any>("GET", `/meals/${it.mealId}${q}`)).meal;
      meals.push(toPlanMeal(it, m, plan.makeAhead?.feastMealId === it.mealId));
      if (typeof m.minutes === "number") this.cards.set(it.mealId, m.minutes);
      reads.set(it.mealId, stepsOf(m));
    }
    return { meals, reads, plan };
  }

  /** One meal's Cook Mode read (the steps the screen shows). */
  async cookRead(meal: PlanMeal, prepped = false): Promise<Record<string, RecipeStep>> {
    const q = `?planItemId=${meal.planItemId}${prepped ? "&prepped=1" : ""}`;
    return stepsOf((await this.api.must<any>("GET", `/meals/${meal.mealId}${q}`)).meal);
  }

  // ── 3. grocery ────────────────────────────────────────────────────────────

  listId: string | null = null;
  /** The list as last read, for R4's prep-vs-list arm. */
  rows: GroceryRow[] | null = null;

  async grocery(): Promise<GroceryEvidence> {
    const gen = await this.api.req<any>("POST", `/plans/${this.planId}/generate-grocery-list`, undefined, { expect: [409] });
    if (gen.status === 409 && gen.body?.existingListId) this.listId = gen.body.existingListId;
    else if (gen.status === 200) this.listId = gen.body.groceryListId;
    else throw new JourneyError(`generate-grocery-list → ${gen.status} ${JSON.stringify(gen.body).slice(0, 200)}`);
    return this.readList("after generation");
  }

  async readList(label: string): Promise<GroceryEvidence & { reconciled: boolean }> {
    const r = await this.api.must<any>("GET", `/grocery-lists/${this.listId}`);
    const items = (r.list.items as any[]).filter((i) => !i.deletedAt);
    const ids = items.map((i) => i.ingredientId).filter(Boolean);
    const canon = new Map(
      (await this.prisma.ingredient.findMany({ where: { id: { in: ids } }, select: { id: true, canonicalName: true } })).map((x) => [x.id, x.canonicalName]),
    );
    const rows: GroceryRow[] = items.map((i) => ({
      id: i.id, displayName: i.userResolvedTo ?? i.displayName, canonicalName: i.ingredientId ? canon.get(i.ingredientId) ?? null : null,
      quantity: Number(i.quantity), unit: i.unit ?? "", mealNames: i.mealNames ?? [], isChecked: !!i.isChecked,
      isUniversalStaple: !!i.isUniversalStaple, isUserPantryStaple: !!i.isUserPantryStaple, isRecurringItem: !!i.isRecurringItem,
      isUserAdded: !!i.isUserAdded, isOptional: !!i.isOptional,
    }));
    const { meals } = await this.loadMeals();
    this.meals = meals;
    this.rows = rows;
    (this.out.evidence.grocery ??= [] as unknown[]) as unknown[];
    (this.out.evidence.grocery as unknown[]).push({ label, reconciled: r.reconciled ?? null, rows });
    return { label, meals, rows, reconciled: !!r.reconciled };
  }

  /** Check off about a third (every third row), as a shopper does. */
  async checkThird(ev: GroceryEvidence): Promise<void> {
    const rows = ev.rows.filter((_, i) => i % 3 === 0);
    for (const r of rows) await this.api.must("PATCH", `/grocery-lists/${this.listId}/items/${r.id}`, { isChecked: true });
    this.out.evidence.checkedOff = rows.length;
  }

  // ── 4. edits (R3) ─────────────────────────────────────────────────────────

  async edit(kind: HouseholdSpec["edits"][number], before: GroceryEvidence): Promise<void> {
    const target = this.meals.find((m) => !m.isFeast) ?? this.meals[0];
    let removedTitles: string[] = [];
    let mealTitle = target.title;
    let mealAliases = target.aliases;
    if (kind === "servings") {
      await this.api.must("PATCH", `/plans/${this.planId}/items/${target.planItemId}`, { servingsOverride: 10 });
    } else if (kind === "bird-weight") {
      const feast = this.meals.find((m) => m.isFeast) ?? this.meals[0];
      mealTitle = feast.title;
      mealAliases = feast.aliases;
      const lb = this.spec.plan.kind === "feast" ? this.spec.plan.birdWeightLb ?? 16 : 16;
      await this.api.must("PATCH", `/plans/${this.planId}/items/${feast.planItemId}`, { birdWeightLb: lb });
    } else if (kind === "swap") {
      // A replacement from the member shelf (free), honouring the household's diet.
      const shelf = await this.api.must<any>("POST", "/wizard/shelf", {
        planDurationDays: 5, householdSize: this.spec.size, difficulty: "easy", weeklyPacing: "mostly_easy",
        eatingStyles: this.spec.prefs.eatingStyles ?? [], allergiesAndAvoidances: this.spec.prefs.allergiesAndAvoidances ?? [],
        excludeMealIds: this.meals.map((m) => m.mealId), size: 6,
      });
      const pick = (shelf.meals as { id: string; title: string }[])[0];
      if (!pick) throw new JourneyError("the shelf offered nothing to swap in");
      await this.api.must("PATCH", `/plans/${this.planId}/items/${target.planItemId}`, { mealId: pick.id });
      removedTitles = target.aliases;
      mealTitle = pick.title;
    } else if (kind === "add-dish") {
      mealTitle = await this.addSavedDish(target);
    }
    const after = await this.readList(`after ${kind}`);
    if (kind !== "swap") mealAliases = after.meals.find((m) => m.mealId === target.mealId)?.aliases ?? mealAliases;
    if (kind === "swap") {
      const swapped = after.meals.find((m) => !before.meals.some((b) => b.mealId === m.mealId));
      if (swapped) {
        mealTitle = swapped.title;
        mealAliases = swapped.aliases;
      }
    }
    this.push(reconcileR3(this.spec.id, { edit: kind, mealTitle, mealAliases, before, after, removedTitles, reconciled: after.reconciled }));
  }

  /**
   * Edit meal → Add a dish → a saved dish → "Apply always" (app/meal-builder.tsx
   * runUpdateMeal with bumpPlanId + overridePlanItemId): the plan item's recipe
   * override, then PATCH /me/meals/:id with every dish re-sent "new" plus the
   * added one, its amounts scaled to the meal's authored servings
   * (meal-builder-state dishDetailToBuilderDish).
   */
  private async addSavedDish(target: PlanMeal): Promise<string> {
    const mine = await this.api.must<any>("GET", "/me/dishes");
    const have = new Set(target.dishes.map((d) => d.dishId));
    const rows = (mine.dishes ?? mine.items ?? []) as { id: string; title: string }[];
    const pick = rows.find((d) => !have.has(d.id));
    if (!pick) throw new JourneyError("no saved dish outside the meal to add");
    const dish = (await this.api.must<any>("GET", `/dishes/${pick.id}`)).dish;
    const canonical = (await this.api.must<any>("GET", `/meals/${target.mealId}`)).meal;
    const anchor = canonical.dishes[0]?.authoredServingsDefault ?? canonical.dishes[0]?.servings ?? dish.servings;
    const k = dish.servings > 0 ? anchor / dish.servings : 1;
    const phase = (p: string) => (["prep", "preheat", "cook", "rest", "assemble", "hold"].includes(p) ? { phaseType: p } : {});
    const asNew = (d: any, idx: number, scale = 1) => ({
      kind: "new" as const,
      title: d.title,
      role: idx === 0 ? "main" : "side",
      positionIndex: idx,
      ingredients: (d.ingredients as any[]).map((i) => ({ name: i.name, quantity: Math.max(0.01, Number(i.quantity) * scale) || 1, unit: i.unit || "unit" })),
      steps: (d.steps as any[]).filter((s) => s.text?.trim()).slice(0, 30).map((s) => ({
        text: String(s.text).slice(0, 500),
        ...(s.estimatedMinutes > 0 ? { estimatedMinutes: Math.round(s.estimatedMinutes) } : {}),
        isTimingSensitive: !!s.isTimingSensitive,
        ...phase(s.phaseType),
      })),
    });
    const dishes = [...canonical.dishes.map((d: any, i: number) => asNew(d, i)), asNew(dish, canonical.dishes.length, k)];
    await this.api.must("PATCH", `/plans/${this.planId}/items/${target.planItemId}`, {
      recipeOverrideJson: {
        titleOverride: canonical.title,
        dishes: dishes.map((d) => ({ name: d.title, ingredients: d.ingredients })),
        createdAt: new Date().toISOString(),
      },
    });
    await this.api.must("PATCH", `/me/meals/${target.mealId}`, {
      title: canonical.title, description: canonical.description ?? null, cuisineType: canonical.cuisineType ?? null,
      dishes, bumpPlanId: this.planId,
    });
    this.out.evidence.addedDish = { meal: target.title, dish: dish.title, scale: k };
    return canonical.title;
  }

  // ── 5. Cook Mode, unprepped (R8) ──────────────────────────────────────────

  async cookUnprepped(): Promise<void> {
    const { meals, reads } = await this.loadMeals();
    this.meals = meals;
    for (const m of meals) {
      this.baseline.set(m.mealId, reads.get(m.mealId)!);
      let sequence: SequencedStep[] | null = null;
      let total: number | null = null;
      if (m.dishes.length > 1) {
        // cook-session.tsx:141 sends { planItemId } when it is in the launch.
        const seq = await this.api.must<any>("POST", `/meals/${m.mealId}/cooking-sequence`, { planItemId: m.planItemId });
        sequence = seq.sequence;
        total = seq.totalEstimatedMinutes ?? null;
      } else {
        total = Object.values(reads.get(m.mealId)!).reduce((n, s) => n + (s.estimatedMinutes ?? 0), 0);
      }
      const card = this.cards.get(m.mealId) ?? null;
      this.push(reconcileR8(this.spec.id, { meal: m, sequence, sequenceTotalMinutes: total, cardTotalMinutes: card }));
    }
  }

  // ── 6. prep ───────────────────────────────────────────────────────────────

  async prep(body: unknown, kind: PrepSession["kind"], mealIds: string[]): Promise<PrepSession & { envelope: any }> {
    const r = await this.api.req<any>("POST", `/plans/${this.planId}/prep-week`, body);
    if (r.status !== 200) throw new JourneyError(`prep-week ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const res = r.body.result;
    const steps: PrepStep[] = (res.phases as any[]).flatMap((p) => (p.steps as any[]).map((s) => ({ ...s, phase: p.phase })));
    const session: PrepSession & { envelope: any } = { kind, mealIds, steps, containerCount: res.containerCount ?? null, envelope: { cacheHit: r.body.cacheHit, subset: r.body.subset, sessionDay: r.body.sessionDay ?? null, ms: r.ms } };
    (this.out.evidence.prep ??= [] as unknown[]) as unknown[];
    (this.out.evidence.prep as unknown[]).push({ kind, mealIds, envelope: session.envelope, steps: steps.map((s) => ({ stepKey: s.stepKey, title: s.title, instructions: s.instructions.slice(0, 400), contributesToMealIds: s.contributesToMealIds, containerNames: s.containerNames, containerId: s.containerId ?? null, covers: s.coversCookSteps?.length ?? 0 })) });
    this.push(reconcileR4(this.spec.id, session, this.meals, this.rows ?? undefined));
    return session;
  }

  async tick(keys: string[], on = true): Promise<void> {
    for (const k of keys) {
      await this.api.must(on ? "PUT" : "DELETE", `/plans/${this.planId}/prep-week/completions`, { stepKey: k });
      if (on) {
        this.ticked.add(k);
        this.out.ticksPut[this.planId] = (this.out.ticksPut[this.planId] ?? 0) + 1;
      } else this.ticked.delete(k);
    }
  }

  /** What "Mark all complete" ticks: every step except one held for cook day ("Cremini mushrooms — cook day"). */
  tickable(session: PrepSession): string[] {
    return session.steps.filter((s) => !s.skipSuggested && !HELD.test(s.title)).map((s) => s.stepKey);
  }

  async weekSession(): Promise<PrepSession> {
    if (this.week) return this.week;
    this.week = await this.prep(undefined, "week", []);
    this.push(reconcileR6(this.spec.id, this.week, []));
    return this.week;
  }

  /** R7 at one checkpoint: every non-feast meal's prepped read against its baseline. */
  async checkPrepToCook(label: string, opts: { prepped?: boolean; only?: PlanMeal[] } = {}): Promise<void> {
    const week = await this.weekSession();
    const refs: CookRef[] = [];
    const meals: PrepToCookMeal[] = [];
    for (const m of opts.only ?? this.meals.filter((x) => !x.isFeast)) {
      const after = await this.cookRead(m, opts.prepped);
      for (const [k, s] of Object.entries(after)) for (const r of s.preppedRefs ?? []) refs.push({ mealTitle: m.title, dishId: k.split("#")[0], stepIndex: s.stepIndex, ...r });
      meals.push({ meal: m, baseline: this.baseline.get(m.mealId) ?? {}, after });
    }
    const ticked = opts.prepped ? new Set(week.steps.map((s) => s.stepKey)) : new Set(this.ticked);
    this.push(reconcileR7(this.spec.id, { label, meals, prepSteps: week.steps, ticked, prepped: !!opts.prepped }));
    this.push(reconcileR6(this.spec.id, week, refs));
    (this.out.evidence.prepToCook ??= [] as unknown[]) as unknown[];
    (this.out.evidence.prepToCook as unknown[]).push({
      label, ticked: [...ticked],
      meals: meals.map((x) => ({ meal: x.meal.title, steps: Object.entries(x.after).map(([k, st]) => ({ k, changed: st.text !== x.baseline[k]?.text, chips: (st.preppedRefs ?? []).map((r) => r.label), text: st.text.slice(0, 160), before: x.baseline[k]?.text.slice(0, 160) })) })),
    });
  }

  /** Prep the Week, partial: about half, leave, come back, a few more. */
  async prepPartial(): Promise<void> {
    const week = await this.weekSession();
    const keys = this.tickable(week);
    const first = keys.filter((_, i) => i % 2 === 0);
    await this.tick(first);
    // Leave and come back: the screen re-reads completions and re-POSTs prep-week (cache).
    const back = await this.api.must<any>("GET", `/plans/${this.planId}/prep-week/completions`);
    const kept = new Set((back.completions as { stepKey: string }[]).map((c) => c.stepKey));
    const lost = first.filter((k) => !kept.has(k));
    const again = await this.api.must<any>("POST", `/plans/${this.planId}/prep-week`);
    this.out.evidence.partialReturn = { ticked: first.length, kept: kept.size, lost, cacheHitOnReturn: again.cacheHit };
    if (lost.length > 0) {
      this.push({ rule: "R7", checked: 1, findings: [{ rule: "R7", signature: "R7:resume-lost-ticks", severity: "high", household: this.spec.id, detail: `left Prep the Week with ${first.length} ticks; ${lost.length} were gone on return (${lost.slice(0, 4).join(", ")})` }] });
    }
    const more = keys.filter((k) => !this.ticked.has(k)).slice(0, 3);
    await this.tick(more);
    await this.checkPrepToCook("after partial prep");
  }

  async prepFull(): Promise<void> {
    const week = await this.weekSession();
    await this.tick(this.tickable(week).filter((k) => !this.ticked.has(k)));
    await this.checkPrepToCook("after full prep");
  }

  /** Prep selected meals / one meal (R5): only those meals; others' Cook Mode unchanged. */
  async prepSubset(kind: "subset" | "one-meal"): Promise<void> {
    const pool = this.meals.filter((m) => !m.isFeast);
    const chosen = kind === "one-meal" ? pool.slice(0, 1) : pool.slice(1, 3);
    if (chosen.length < (kind === "one-meal" ? 1 : 2)) throw new JourneyError(`not enough meals for ${kind}`);
    const others = pool.filter((m) => !chosen.includes(m));
    const reads = async () => Object.fromEntries(await Promise.all(others.map(async (m) => [m.mealId, await this.cookRead(m)] as const)));
    const before = await reads();
    const session = await this.prep({ mealIds: chosen.map((m) => m.mealId) }, kind, chosen.map((m) => m.mealId));
    this.push(reconcileR6(this.spec.id, session, []));
    const served = await reads();
    const keys = session.steps.map((s) => s.stepKey);
    await this.tick(keys);
    const ticked = await reads();
    this.push(reconcileR5(this.spec.id, { session, before, served, ticked, titles: Object.fromEntries(this.meals.map((m) => [m.mealId, m.title])) }));
    // Untick, so the week's prep → cook checks start from a clean plan.
    await this.tick(keys, false);
  }

  /** Recipes tab → Cook Mode → "Yes, I prepped" (cook-session.tsx:113-124): the active plan's item, prepped=1. */
  async recipesYes(): Promise<void> {
    const plans = await this.api.must<any>("GET", "/plans");
    const active = plans.activeThisWeek?.id ?? (plans.plans as any[]).find((p) => p.isActiveThisWeek)?.id;
    if (active !== this.planId) this.out.evidence.recipesYesActive = { active, plan: this.planId };
    const meal = this.meals.filter((m) => !m.isFeast).slice(-1)[0];
    await this.checkPrepToCook(`Recipes · Yes, I prepped (${meal.title})`, { prepped: true, only: [meal] });
  }

  // ── 7. the feast (R9, R4, R6, R8) ─────────────────────────────────────────

  async feast(): Promise<void> {
    const { meals, plan } = await this.loadMeals();
    this.meals = meals;
    const feast = meals.find((m) => m.isFeast);
    if (!feast || !plan.makeAhead) throw new JourneyError("the plan has no feast (no makeAhead)");
    const session = await this.prep({ session: "feast" }, "feast", [feast.mealId]);
    const rows = plan.makeAhead.rows as MakeAheadRow[];
    const raw = (await this.api.must<any>("GET", `/meals/${feast.mealId}?planItemId=${feast.planItemId}`)).meal;
    this.out.evidence.makeAhead = plan.makeAhead;
    this.push(reconcileR9(this.spec.id, {
      label: this.spec.plan.kind === "feast" ? this.spec.plan.name : "feast",
      feastDate: plan.makeAhead.feastDate, feastDayName: plan.makeAhead.feastDayName, rows,
      birdWeightLb: feast.birdWeightLb, recipeLb: recipeLbOf(raw), sessionDay: session.envelope.sessionDay,
    }));
    await this.tick(session.steps.map((s) => s.stepKey));
    // Cook Mode for the day: the feast's wording, its containers made in Prep the feast.
    const day = await this.cookRead(feast);
    const refs: CookRef[] = [];
    for (const [k, s] of Object.entries(day)) for (const r of s.preppedRefs ?? []) refs.push({ mealTitle: feast.title, dishId: k.split("#")[0], stepIndex: s.stepIndex, ...r });
    this.push(reconcileR6(this.spec.id, session, refs));
  }

  // ── 8. finish a cook ──────────────────────────────────────────────────────

  async finish(): Promise<void> {
    const m = this.meals.find((x) => x.isFeast) ?? this.meals[this.meals.length - 1];
    // Walk to the last step (the sequence the screen steps through), then the finish.
    if (m.dishes.length > 1) await this.api.must("POST", `/meals/${m.mealId}/cooking-sequence`, { planItemId: m.planItemId });
    const r = await this.api.must<any>("POST", "/me/activity/cook-finished", { mealId: m.mealId, planItemId: m.planItemId });
    if (r.recorded === true) this.out.finishesRecorded++;
    // The same finish again within a minute is one finish (200 recorded:false).
    const again = await this.api.req<any>("POST", "/me/activity/cook-finished", { mealId: m.mealId, planItemId: m.planItemId });
    this.out.evidence.finish = { meal: m.title, first: r, again: { status: again.status, body: again.body } };
  }

  // ── 9. delete, and prove it ───────────────────────────────────────────────

  async deleteAccount(): Promise<void> {
    if (!this.api.token || !this.out.userId) return;
    const old = this.api.token;
    const d = await this.api.req("DELETE", "/me", { confirm: "delete", currentPassword: this.password });
    this.out.deleted.status = d.status;
    const me = await this.api.req("GET", "/auth/me", undefined, { expect: [401], token: old });
    this.out.deleted.meAfter = me.status;
    const row = await this.prisma.user.findUnique({ where: { id: this.out.userId }, select: { id: true } });
    this.out.deleted.rowGone = row === null;
  }
}

// ── wire → evidence ──────────────────────────────────────────────────────────

/** A step Prep the Week holds for cook day: shown, never ticked by "Mark all complete". */
const HELD = /— cook day$/;

const BIRD = /\bturkey\b/i;
const NOT_BIRD = /broth|stock|gravy|neck|giblet|bacon|sausage|drippings|ground/i;

export function toPlanMeal(item: any, m: any, isFeast: boolean): PlanMeal {
  const aliases = [m.title, m.displayTitle, item.recipeOverrideJson?.titleOverride].filter((x): x is string => !!x);
  const feast = isFeast || (m.tags ?? []).includes("thanksgiving-feast");
  return {
    planItemId: item.id,
    mealId: item.mealId,
    title: m.displayTitle ?? m.title,
    aliases: [...new Set(aliases)],
    servingsOverride: item.servingsOverride ?? null,
    birdWeightLb: item.birdWeightLb ?? m.birdWeightLb ?? null,
    isFeast: feast,
    dishes: (m.dishes as any[]).map((d) => ({
      dishId: d.dishId,
      title: d.title,
      servings: d.authoredServingsDefault ?? d.servings,
      defaultServings: d.servings,
      isBirdDish: feast && (d.ingredients as any[]).some((i) => BIRD.test(i.name) && !NOT_BIRD.test(i.name)),
      ingredients: (d.ingredients as any[]).map((i) => ({ name: i.name, quantity: Number(i.quantity), unit: i.unit ?? "", isOptional: !!i.isOptional })),
      steps: (d.steps as any[]).map((s) => ({ stepIndex: s.stepIndex, text: s.text, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, parallelGroup: s.parallelGroup ?? null, ...(s.preppedRefs ? { preppedRefs: s.preppedRefs } : {}) })),
    })),
  };
}

export function stepsOf(m: any): Record<string, RecipeStep> {
  const out: Record<string, RecipeStep> = {};
  for (const d of m.dishes as any[]) {
    for (const s of d.steps as any[]) {
      out[cookKey(d.dishId, s.stepIndex)] = { stepIndex: s.stepIndex, text: s.text, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, parallelGroup: s.parallelGroup ?? null, ...(s.preppedRefs ? { preppedRefs: s.preppedRefs } : {}) };
    }
  }
  for (const s of (m.steps ?? []) as any[]) {
    out[cookKey("meal", s.stepIndex)] = { stepIndex: s.stepIndex, text: s.text, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, ...(s.preppedRefs ? { preppedRefs: s.preppedRefs } : {}) };
  }
  return out;
}

/** The recipe's own bird weight, from its turkey line: "1 whole turkey (12–14 lb)", "14 lb turkey". */
export function recipeLbOf(m: any): { min: number; max: number } | null {
  for (const d of (m.dishes ?? []) as any[]) {
    for (const i of (d.ingredients ?? []) as any[]) {
      const text = `${i.quantity} ${i.unit} ${i.name} ${i.preparationNote ?? ""}`;
      if (!BIRD.test(text) || NOT_BIRD.test(i.name)) continue;
      const range = /(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*-?\s*(?:lb|pound)/i.exec(text);
      if (range) return { min: Number(range[1]), max: Number(range[2]) };
      if (/^(lb|lbs|pound|pounds)$/i.test(String(i.unit).trim())) return { min: Number(i.quantity), max: Number(i.quantity) };
      const one = /(\d+(?:\.\d+)?)\s*-?\s*(?:lb|pound)/i.exec(text);
      if (one) return { min: Number(one[1]), max: Number(one[1]) };
    }
  }
  return null;
}
