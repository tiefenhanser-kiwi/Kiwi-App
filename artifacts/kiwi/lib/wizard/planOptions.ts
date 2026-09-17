// WS9 Plan-flow redesign (D-WS9-191) Block 2 — the plan-options screen's whole
// state machine, with no React in it.
//
// The screen (app/plan-options.tsx) is outside the test glob (D-WS9-164), so
// every rule lives here and is pinned by lib/wizard/__tests__/planOptions.test.ts:
// the card list and its states, where "Get another plan option" inserts the
// new card, how many presses are left, what the exclusion / dismiss / expand
// bodies carry, and the card's meta line + rows. The screen file only wires
// these to fetches and navigation.
//
// Hans's ruling (D-WS9-191, September 16): one screen of candidate cards, each a
// pared-back plan review, with three actions — Use This Week · Save for Later ·
// Not For Me — and ONE button below the cards, "Get another plan option": one
// press = one plan, four presses then the refine-or-Tell-Kiwi card. Not For Me
// logs a row and learns nothing. There is no unsaved-draft Plan Review, no
// "View details", no "More options ↺".

import type { WizardExpandCandidateContext } from "../api/wizard";
import type { ParsedIntent } from "../api/tellKiwi";
import type {
  TellKiwiInput,
  WizardPlanCandidate,
  WizardPlanCandidateMeal,
  WizardPreferencesInput,
} from "../types";
import {
  accumulateShownPlans,
  EMPTY_SESSION_EXCLUSION,
  toExclusionRequest,
} from "./sessionExclusion";

// ── The list ──────────────────────────────────────────────────────────────

export type PlanOptionCardState = "fresh" | "busy" | "saved" | "dismissed";

export interface PlanOptionCard {
  /** Render key. The candidate's content identity (candidateIdentity), disambiguated when a later batch repeats one. */
  key: string;
  candidate: WizardPlanCandidate;
  state: PlanOptionCardState;
  /** After Save for Later — the real plan id. The draft id is dead once set. */
  planId?: string;
  /** After a successful expand — reused by a later action on the same card. */
  draftId?: string;
}

export type PlanOptionList = ReadonlyArray<PlanOptionCard>;

export const EMPTY_PLAN_OPTIONS: PlanOptionList = [];

/** The server's default for `wizard.max_refreshes_per_session`; the screen uses it until GET /wizard/limits answers (and if it never does). */
export const DEFAULT_MAX_PRESSES = 4;

function uniqueKey(list: PlanOptionList, id: string): string {
  const taken = new Set(list.map((c) => c.key));
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}

// BUG-289 — identity is CONTENT, never `candidate.id`. The server's
// wizardContentHash.ts header says why: the id is an AI-minted free string that
// "can collide across generate calls, and regenerates on every call. It is
// therefore useless as an idempotency key" — the finding BUG-030 built the
// content hash on. Two separate single-plan "another" calls re-mint the same
// id, so keying on it made the second press read as a re-delivered frame and
// froze the screen. This mirrors computeWizardContentHash's normalisation
// (NFKC, trim, lowercase, collapse whitespace; title + meal titles sorted) as
// a plain composite string — no hashing needed client-side.
function normalizeTitle(s: string): string {
  return s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** The content identity of a candidate: its normalised title + sorted normalised meal titles. */
export function candidateIdentity(candidate: WizardPlanCandidate): string {
  const meals = (candidate.mealTitles ?? [])
    .map((t) => normalizeTitle(typeof t === "string" ? t : ""))
    .filter((t) => t.length > 0)
    .sort();
  return JSON.stringify({ t: normalizeTitle(candidate.title ?? ""), m: meals });
}

/** True when a card with the same CONTENT identity is already in the list. */
export function hasCandidate(list: PlanOptionList, candidate: WizardPlanCandidate): boolean {
  const identity = candidateIdentity(candidate);
  return list.some((c) => candidateIdentity(c.candidate) === identity);
}

/**
 * Fold an arriving batch into the list as fresh cards, in arrival order. A
 * stream re-delivers cards it already sent (the catch-up before `done`), so a
 * candidate whose CONTENT identity is already present is skipped; returns the
 * SAME reference when nothing is new so a React effect can skip a redundant
 * write. Two candidates that share an AI-minted `id` but differ in content are
 * BOTH kept (BUG-289).
 */
export function appendCandidates(
  list: PlanOptionList,
  candidates: ReadonlyArray<WizardPlanCandidate>,
): PlanOptionList {
  let next: PlanOptionCard[] | null = null;
  for (const candidate of candidates) {
    if (hasCandidate(next ?? list, candidate)) continue;
    next = next ?? [...list];
    next.push({ key: uniqueKey(next, candidateIdentity(candidate)), candidate, state: "fresh" });
  }
  return next ?? list;
}

/**
 * "Get another plan option" — the new card goes where the last dismissed card
 * was (the user rejected a slot and asked for something in its place), else
 * the bottom. A dismissed card stays in the list (collapsed) so its titles keep
 * feeding the exclusion; inserting AT its index puts the new card in front of
 * it, which is the same slot on screen. An index outside the list, or null
 * (nothing dismissed yet), means the bottom. Same CONTENT identity already
 * present → the SAME reference (a re-delivered frame).
 */
export function insertAnother(
  list: PlanOptionList,
  candidate: WizardPlanCandidate,
  lastDismissedIndex: number | null,
): PlanOptionList {
  if (hasCandidate(list, candidate)) return list;
  const card: PlanOptionCard = {
    key: uniqueKey(list, candidateIdentity(candidate)),
    candidate,
    state: "fresh",
  };
  const at =
    lastDismissedIndex !== null &&
    lastDismissedIndex >= 0 &&
    lastDismissedIndex < list.length
      ? lastDismissedIndex
      : list.length;
  return [...list.slice(0, at), card, ...list.slice(at)];
}

/** Replace one card's state (and optionally its ids). Unknown key → same reference. */
export function patchCard(
  list: PlanOptionList,
  key: string,
  patch: Partial<Pick<PlanOptionCard, "state" | "planId" | "draftId">>,
): PlanOptionList {
  const idx = list.findIndex((c) => c.key === key);
  if (idx === -1) return list;
  const next = [...list];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

/**
 * Not For Me — the card collapses and its index is remembered so the next
 * "another" lands in its slot. A busy or already-dismissed card is left alone
 * (same reference, index null).
 */
export function dismissCard(
  list: PlanOptionList,
  key: string,
): { list: PlanOptionList; dismissedIndex: number | null } {
  const idx = list.findIndex((c) => c.key === key);
  if (idx === -1) return { list, dismissedIndex: null };
  const card = list[idx];
  if (card.state === "busy" || card.state === "dismissed") {
    return { list, dismissedIndex: null };
  }
  return { list: patchCard(list, key, { state: "dismissed" }), dismissedIndex: idx };
}

/** The cards on screen — everything not dismissed. */
export function visibleCards(list: PlanOptionList): PlanOptionCard[] {
  return list.filter((c) => c.state !== "dismissed");
}

/** True while any card's action is in flight — the other cards' actions disable. */
export function anyBusy(list: PlanOptionList): boolean {
  return list.some((c) => c.state === "busy");
}

// ── The cap ───────────────────────────────────────────────────────────────

/**
 * Presses of "Get another plan option" left this screen session. The cap is
 * the server's `maxRefreshesPerSession` (re-meant as presses; the initial batch
 * is not a press). A non-finite or negative cap reads as the default.
 */
export function pressesLeft(cap: number | null | undefined, presses: number): number {
  const effectiveCap =
    typeof cap === "number" && Number.isFinite(cap) && cap >= 0
      ? Math.floor(cap)
      : DEFAULT_MAX_PRESSES;
  return Math.max(0, effectiveCap - Math.max(0, Math.floor(presses)));
}

// ── Request bodies ────────────────────────────────────────────────────────

export interface PlanOptionsExclusion {
  /** Every plan title shown OR dismissed this session. */
  excludePlanTitles: string[];
  /** Every meal title across those plans. */
  excludeMealTitles: string[];
  /** The subset the user rejected with Not For Me. */
  dismissedPlanTitles: string[];
}

/**
 * The exclusion an "another" call carries — built on sessionExclusion.ts's
 * accumulator (dedupe by plan title, blank titles ignored), not beside it.
 * Every card in the list has been shown, dismissed or not; the dismissed
 * subset rides separately as `dismissedPlanTitles`.
 */
export function exclusionFor(list: PlanOptionList): PlanOptionsExclusion {
  const shown = accumulateShownPlans(
    EMPTY_SESSION_EXCLUSION,
    list.map((c) => ({ title: c.candidate.title, mealTitles: c.candidate.mealTitles })),
  );
  const dismissed = new Set<string>();
  for (const c of list) {
    if (c.state === "dismissed" && c.candidate.title) dismissed.add(c.candidate.title);
  }
  return {
    ...toExclusionRequest(shown),
    dismissedPlanTitles: [...dismissed],
  };
}

/**
 * The extra keys merged into the ORIGINAL generation body for one "Get another
 * plan option" call (POST /wizard/build-plans or /build-from-text). `another`
 * is the contract's field; `candidateCount: 1` is the Block 1 server shape's
 * request field for the same call — both sent so either reading of the server
 * lane's name lands (D-WS9-191 Block 1 shape (b)/(c)).
 */
export interface AnotherRequestExtras {
  excludePlanTitles: string[];
  excludeMealTitles: string[];
  another: { dismissedPlanTitles: string[] };
  candidateCount: 1;
}

export function anotherRequestFor(list: PlanOptionList): AnotherRequestExtras {
  const { excludePlanTitles, excludeMealTitles, dismissedPlanTitles } = exclusionFor(list);
  return {
    excludePlanTitles,
    excludeMealTitles,
    another: { dismissedPlanTitles },
    candidateCount: 1,
  };
}

export type PlanOptionsSource = "wizard" | "tellkiwi";

/** POST /wizard/candidates/dismiss body — the row a future wizard can read; nothing acts on it now. */
export interface DismissCandidateRequest {
  title: string;
  mealTitles: string[];
  storeMealIds?: string[];
  source: PlanOptionsSource;
}

export function dismissRequestFor(
  candidate: WizardPlanCandidate,
  source: PlanOptionsSource,
): DismissCandidateRequest {
  const storeMealIds = (candidate.meals ?? [])
    .map((m) => m.storeMealId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    title: candidate.title,
    mealTitles: candidate.mealTitles,
    ...(storeMealIds.length > 0 ? { storeMealIds } : {}),
    source,
  };
}

/**
 * The WizardExpandCandidateContext for POST /wizard/expand, from whichever
 * entry's input the screen holds. Lifted verbatim in rule from the retired
 * chooser: Set Prefs carries all fields; Tell Kiwi has no `difficulty` (free
 * text) so "medium" is the soft hint; planDurationDays falls back to the meal
 * count.
 *
 * ⚠️ WS9 BUG-201 — with NO input at all, allergiesAndAvoidances / eatingStyles
 * are OMITTED, never sent as []. `[]` asserts the user has no constraints, and
 * that assertion reaches the prompt that authors ingredients. Omitting makes
 * the server resolve from stored — the only honest answer a no-input fallback
 * can give.
 */
export function buildCandidateContext(
  candidate: WizardPlanCandidate,
  wizardInput: WizardPreferencesInput | null,
  tellKiwiInput: TellKiwiInput | null,
): WizardExpandCandidateContext {
  const fallbackDays = Math.max(1, Math.min(7, candidate.mealTitles.length || 5));
  if (wizardInput) {
    return {
      planDurationDays: wizardInput.planDurationDays,
      householdSize: wizardInput.householdSize,
      // Inert server-side (D-WS7-190) but the expand schema expects a boolean.
      wantsLeftovers: false,
      allergiesAndAvoidances: wizardInput.allergiesAndAvoidances,
      eatingStyles: wizardInput.eatingStyles,
      difficulty: wizardInput.difficulty,
      saucePreference: wizardInput.saucePreference,
      maxCookTimeMinutes: wizardInput.maxCookTimeMinutes,
      maxCookTimeCoverage: wizardInput.maxCookTimeCoverage,
    };
  }
  if (tellKiwiInput) {
    return {
      planDurationDays: tellKiwiInput.planDurationDays ?? fallbackDays,
      householdSize: tellKiwiInput.householdSize,
      wantsLeftovers: false,
      allergiesAndAvoidances: tellKiwiInput.allergiesAndAvoidances,
      eatingStyles: tellKiwiInput.eatingStyles,
      difficulty: "medium",
      saucePreference: tellKiwiInput.saucePreference,
      maxCookTimeMinutes: tellKiwiInput.maxCookTimeMinutes,
      maxCookTimeCoverage: tellKiwiInput.maxCookTimeCoverage,
    };
  }
  return {
    planDurationDays: fallbackDays,
    householdSize: 4,
    wantsLeftovers: false,
    difficulty: "medium",
  };
}

// ── The card's text ───────────────────────────────────────────────────────

export interface PlanOptionRow {
  title: string;
  /** null → no description line. */
  description: string | null;
  /** Store-bound slots only. */
  estimatedTimeMinutes?: number;
}

/**
 * The meal rows: the wire's `meals` (title + description, in mealTitles order)
 * when the server sent them; a legacy candidate without `meals` renders
 * title-only rows from `mealTitles`. A `meals` array whose length disagrees
 * with `mealTitles` is not trusted for pairing — titles win, descriptions are
 * matched by title where they can be.
 */
export function rowsFor(candidate: WizardPlanCandidate): PlanOptionRow[] {
  const meals: WizardPlanCandidateMeal[] | undefined = candidate.meals;
  if (Array.isArray(meals) && meals.length === candidate.mealTitles.length) {
    return meals.map((m) => ({
      title: m.title || "",
      description: typeof m.description === "string" && m.description.trim() ? m.description : null,
      ...(typeof m.estimatedTimeMinutes === "number" ? { estimatedTimeMinutes: m.estimatedTimeMinutes } : {}),
    }));
  }
  const byTitle = new Map<string, WizardPlanCandidateMeal>();
  for (const m of meals ?? []) if (m?.title) byTitle.set(m.title, m);
  return candidate.mealTitles.map((title) => {
    const m = byTitle.get(title);
    return {
      title,
      description: m && typeof m.description === "string" && m.description.trim() ? m.description : null,
      ...(m && typeof m.estimatedTimeMinutes === "number" ? { estimatedTimeMinutes: m.estimatedTimeMinutes } : {}),
    };
  });
}

/**
 * The row's cook-time label ("25 min") — ONLY when the wire carried a time
 * (a store-bound slot). Never invented or estimated: the generate bodies
 * forbid claiming a time for a meal composed fresh, and a live slot has none
 * → null, nothing rendered. (Hans, device pass: cook time on each meal row.)
 */
export function rowTimeLabel(row: Pick<PlanOptionRow, "estimatedTimeMinutes">): string | null {
  const t = row.estimatedTimeMinutes;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return null;
  return `${Math.round(t)} min`;
}

/** Round to the nearest 5 minutes ("~40 min avg"). */
export function roundTo5(minutes: number): number {
  return Math.max(5, Math.round(minutes / 5) * 5);
}

/**
 * "5 dinners · serves 4 · ~40 min avg" — the mockup's decision-relevant meta
 * line, derived client-side. The avg appears only when at least half the rows
 * carry `estimatedTimeMinutes` (store-bound slots); "serves" only when the
 * household size is known.
 */
export function metaLine(
  candidate: WizardPlanCandidate,
  householdSize: number | null | undefined,
): string {
  const rows = rowsFor(candidate);
  const n = rows.length;
  const parts = [`${n} ${n === 1 ? "dinner" : "dinners"}`];
  if (typeof householdSize === "number" && Number.isFinite(householdSize) && householdSize > 0) {
    parts.push(`serves ${householdSize}`);
  }
  const timed = rows
    .map((r) => r.estimatedTimeMinutes)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
  if (n > 0 && timed.length * 2 >= n) {
    const avg = timed.reduce((a, b) => a + b, 0) / timed.length;
    parts.push(`~${roundTo5(avg)} min avg`);
  }
  return parts.join(" · ");
}

// ── Header + notices ──────────────────────────────────────────────────────

export const PLAN_OPTIONS_TITLE = "Pick a plan";
export const ANOTHER_LABEL = "Get another plan option";
export const USE_LABEL = "Use This Week";
export const USE_BUSY_LABEL = "Building your week…";
export const SAVE_LABEL = "Save for Later";
export const SAVE_BUSY_LABEL = "Saving…";
export const DISMISS_LABEL = "Not For Me";
export const SAVED_LINE = "Saved ✓";
export const WHY_LABEL = "Why this works";
export const EXHAUSTED_PLANS_TITLE = "Not many plans fit your preferences and restrictions.";

export type PlanOptionsMode = "wizard" | "tellkiwi" | "rehydrate";

/**
 * The header subline. The retired chooser's copy where it had one, with the
 * live count in place of its hard-coded "3": the wizard's "plans Kiwi cooked
 * up just for you", Tell Kiwi's per-scenario lines, "Your previous options"
 * on a rehydrate. While the first batch is in flight (no cards yet) the line
 * says Kiwi is cooking.
 */
export function sublineFor(
  mode: PlanOptionsMode,
  visibleCount: number,
  scenario?: ParsedIntent["scenario"] | null,
): string {
  if (mode === "rehydrate") return "Your previous options";
  if (mode === "tellkiwi") {
    switch (scenario) {
      case "fully_specified":
        return "Here's your plan — exactly as you described";
      case "overflow":
        return "Here's a 5-night plan from your list";
      case "partial":
        return `${visibleCount} ${visibleCount === 1 ? "plan" : "plans"} built around what you named`;
      default:
        return `${visibleCount} ${visibleCount === 1 ? "plan" : "plans"} Kiwi built from your request`;
    }
  }
  if (visibleCount === 0) return "Kiwi is cooking up a few plans…";
  return `${visibleCount} ${visibleCount === 1 ? "plan" : "plans"} Kiwi cooked up just for you`;
}

/**
 * The one quiet line above the cards, or null: Tell Kiwi's overflow (the meals
 * that did not fit) and the generate endpoints' cannotGenerateMore reason.
 */
export function noticeFor(input: {
  scenario?: ParsedIntent["scenario"] | null;
  overflowMeals?: string[] | null;
  cannotGenerateMore?: boolean;
  reason?: string | null;
}): string | null {
  if (input.scenario === "overflow" && input.overflowMeals && input.overflowMeals.length > 0) {
    return `Couldn't fit them all in 5 nights — left out: ${input.overflowMeals.join(", ")}`;
  }
  if (input.cannotGenerateMore) {
    return input.reason || "Kiwi couldn't produce more distinct plans for these constraints.";
  }
  return null;
}
