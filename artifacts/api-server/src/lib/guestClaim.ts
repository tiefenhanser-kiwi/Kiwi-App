// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — THE CLAIM.
//
// A guest builds a plan with no account. At sign-up (or sign-in) the plan
// follows them. Phase 0 established that this cannot be a TRANSFER, because
// the guest never owned a row to transfer: it is a FIRST PERSIST for the real
// user, replaying `persistWizardDraft` → finalize → materialize against the
// JSON blob on the session.
//
// ── 🔴 THE PROPOSAL THIS FILE REFUSES, AND WHY ───────────────────────────
//
// The commission said: extend the signup $transaction with "…
// persistWizardDraft(tx) → activateWizardDraft → markFirstPlanCreated(tx) …",
// one transaction, done. Two facts in the code make that impossible:
//
//  1. THERE IS NO `activateWizardDraft`. Zero hits in src/, with and without
//     --no-ignore. Activation is a ~290-line ROUTE BODY
//     (POST /wizard/drafts/:id/activate) orchestrating
//     readAndFinalizeWizardDraft → materializeWizardDraft → the flip. This
//     file composes those same primitives; it does not copy the route.
//
//  2. THE CLAIM CANNOT BE ONE TRANSACTION, and the existing code says so in
//     its own comments. `materializeWizardDraft` requires BOTH a plain client
//     (Pass 1: re-reads the draft row, upserts ingredients) and a `tx` (Pass 2:
//     the meal graph) — so the draft row must be COMMITTED before materialize
//     can read it, which a single enclosing transaction forbids. And the
//     activate route keeps finalize outside its transaction on purpose: "the
//     ~Sonnet latency would blow the 60s tx budget". Its tx runs at
//     timeout 60_000 / maxWait 20_000 against a measured ~17 s tail; signup's
//     default budget is 5 s.
//
// So the claim is TWO STAGES, and the seam between them is chosen, not
// accidental:
//
//   Stage 1 (INSIDE the signup transaction): the account, the preferences
//   copy, and the session marked claimed. Atomic. The mark is a guarded
//   updateMany on `claimedAt: null`, so two concurrent sign-ups against one
//   session cannot both win.
//
//   Stage 2 (AFTER it commits): persist → finalize → materialize the plan.
//   IF THIS FAILS, THE SIGN-UP STILL SUCCEEDS. The account exists, the
//   preferences are theirs, the response carries `claimedPlanId: null` and a
//   warning. Failing a sign-up because a plan copy fell over would be the
//   wrong trade in every direction: the visitor has typed a password and
//   committed, and the plan is reproducible while the moment is not.
//
// ── What the claim does NOT do ───────────────────────────────────────────
//
// An EXISTING user's preferences are never overwritten by a guest blob. A
// sign-in claim copies the plan and nothing else. Someone who has been using
// Kiwi for a month and idly tries the Test Kitchen on a laptop must not have
// their allergy list replaced by whatever they typed into a public demo.

import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { markFirstPlanCreated } from "./firstPlan";
import { logger } from "./logger";
import { copyTemplateForUser } from "./planFromTemplate";
import { addUtcDays, activeWindowFromToday, todayFor } from "./planDayAssignment";
import { resolveThisWeekWinnerId } from "./planDates";
import { emitActivity } from "./userActivity";
import { runAICall as productionRunAICall } from "./ai/runAICall";
import { WizardExpandedPlanDetailsSchema } from "./ai/schemas/wizard";
import { computeWizardContentHash } from "./wizardContentHash";
import { materializeWizardDraft as productionMaterializeWizardDraft } from "./wizardActivation";
import { persistWizardDraft as productionPersistWizardDraft } from "./wizardExpansion";
import { readAndFinalizeWizardDraft as productionReadAndFinalize } from "./wizardFinalize";

// ── the preferences copy set ─────────────────────────────────────────────
//
// ⚠️ THIS IS NOT `preferencesPatchSchema`, AND IT CANNOT BE.
//
// The commission said to validate `weeklyPacingDefault` "through the same Zod
// the PATCH uses". It is not there: routes/me.ts's preferencesPatchSchema is
// `.strict()` and deliberately EXCLUDES difficultyDefault, weeklyPacingDefault
// and the rest, with the comment "server-only columns … cannot be set by
// clients". Reusing it would reject exactly the two fields the wizard collects.
//
// So this is its own schema over the WIZARD BODY's field names, which are not
// the column names either: `difficulty` → difficultyDefault, `weeklyPacing` →
// weeklyPacingDefault, `planDurationDays` → planLengthDefault. Every enum is
// validated against the same value set the Prisma enum holds, which is the
// real content of the "validate it" instruction — weeklyPacingDefault caused a
// prefs-save 400 in Cookbook Phase B by carrying a value the column refused.
//
// Everything not named here stays at its column default. A guest wizard body
// is not a preferences screen and must not be read as one.
export const GuestPreferencesSchema = z
  .object({
    householdSize: z.number().int().min(1).max(30).optional(),
    wantsLeftovers: z.boolean().optional(),
    cuisines: z.array(z.string().max(60)).max(60).optional(),
    eatingStyles: z.array(z.string().max(60)).max(30).optional(),
    allergiesAndAvoidances: z.array(z.string().max(60)).max(60).optional(),
    // Row 13 · Block 1b Part C — the free-text allergies, on D-WS9-206's terms.
    // The field matters more than its size suggests: the chip list above is a
    // fixed vocabulary and `otherAllergies` is where anything outside it goes,
    // so the entries most likely to be a real medical constraint are exactly
    // the ones that land here. Same bounds as allergiesAndAvoidances; same
    // column type (String[] @default([])).
    //
    // ⚠️ WIRED BUT NOT YET REACHABLE FROM THE FUNNEL, and the gap is upstream,
    // not here. Block 1b's brief said "the wizard collects them, the claim
    // drops them"; the second half was the only true half. WizardInputSchema
    // (ai/schemas/wizard.ts) has NO otherAllergies key and is a plain z.object,
    // so a guest client sending the field has it STRIPPED at POST
    // /wizard/build-plans — it never reaches the session blob for the claim to
    // drop. Closing that needs a field on WizardInputSchema AND a ruling on
    // allergen resolution (the shelf filter and the prompt read
    // allergiesAndAvoidances only), because collecting a constraint while
    // generating a plan that ignores it is worse than not collecting it.
    // REPORTED for an ID; deliberately not guessed at here.
    otherAllergies: z.array(z.string().max(60)).max(60).optional(),
    dietaryNotes: z.string().max(500).nullable().optional(),
    // Wizard-body names → UserPreferences column names, mapped below.
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    weeklyPacing: z
      .enum(["mostly_easy", "mixed", "one_fancy_night", "minimal_effort"])
      .optional(),
    planDurationDays: z.number().int().min(1).max(7).optional(),
    // The five dials.
    discoveryLevel: z.enum(["none", "some", "mostly", "all"]).optional(),
    playlistLevel: z.enum(["none", "some", "mostly", "all"]).optional(),
    saucePreference: z.enum(["store_bought", "balanced", "homemade"]).optional(),
    maxCookTimeMinutes: z.number().int().positive().max(600).nullable().optional(),
    maxCookTimeCoverage: z.enum(["all", "most"]).optional(),
  })
  // NOT .strict(): the wizard body legitimately carries fields that are not
  // preferences (additionalNotes, the per-run echo). Unknown keys are stripped,
  // which is the behaviour we want — an unrecognised key must not 400 a signup.
  .passthrough();

export type GuestPreferencesInput = z.infer<typeof GuestPreferencesSchema>;

/** Wizard-body shape → UserPreferences columns. Only what was actually sent. */
export function toUserPreferencesCreateData(
  parsed: GuestPreferencesInput,
): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (parsed.householdSize !== undefined) d.householdSize = parsed.householdSize;
  if (parsed.wantsLeftovers !== undefined) d.wantsLeftovers = parsed.wantsLeftovers;
  if (parsed.cuisines !== undefined) d.cuisines = parsed.cuisines;
  if (parsed.eatingStyles !== undefined) d.eatingStyles = parsed.eatingStyles;
  if (parsed.allergiesAndAvoidances !== undefined) {
    d.allergiesAndAvoidances = parsed.allergiesAndAvoidances;
  }
  // Part C — presence semantics, exactly as for every key here: absent leaves
  // the column at its `@default([])`, never an empty array written over it.
  if (parsed.otherAllergies !== undefined) {
    d.otherAllergies = parsed.otherAllergies;
  }
  if (parsed.dietaryNotes !== undefined) d.dietaryNotes = parsed.dietaryNotes;
  if (parsed.difficulty !== undefined) d.difficultyDefault = parsed.difficulty;
  if (parsed.weeklyPacing !== undefined) {
    d.weeklyPacingDefault = parsed.weeklyPacing;
  }
  if (parsed.planDurationDays !== undefined) {
    d.planLengthDefault = parsed.planDurationDays;
  }
  if (parsed.discoveryLevel !== undefined) d.discoveryLevel = parsed.discoveryLevel;
  if (parsed.playlistLevel !== undefined) d.playlistLevel = parsed.playlistLevel;
  if (parsed.saucePreference !== undefined) {
    d.saucePreference = parsed.saucePreference;
  }
  if (parsed.maxCookTimeMinutes !== undefined) {
    d.maxCookTimeMinutes = parsed.maxCookTimeMinutes;
  }
  if (parsed.maxCookTimeCoverage !== undefined) {
    d.maxCookTimeCoverage = parsed.maxCookTimeCoverage;
  }
  return d;
}

// ── stage 1 ──────────────────────────────────────────────────────────────

export class GuestSessionInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`guest session invalid: ${detail}`);
    this.name = "GuestSessionInvalidError";
  }
}

export interface ClaimInTxOptions {
  tx: Prisma.TransactionClient;
  guestSessionId: string;
  userId: string;
  /**
   * Signup: true — the account is new and has no preferences.
   * Sign-in: FALSE. An existing user's preferences are never overwritten by a
   * guest blob; see the header.
   */
  copyPreferences: boolean;
  now?: Date;
}

/** The draft blob stage 2 will materialize, or null if the guest never expanded. */
export type ClaimInTxResult = { draft: unknown | null };

export async function claimGuestSessionInTx(
  opts: ClaimInTxOptions,
): Promise<ClaimInTxResult> {
  const { tx, guestSessionId, userId, copyPreferences } = opts;
  const now = opts.now ?? new Date();

  const session = await tx.guestSession.findUnique({
    where: { id: guestSessionId },
    select: {
      id: true,
      expiresAt: true,
      claimedAt: true,
      preferences: true,
      draft: true,
    },
  });
  if (!session) throw new GuestSessionInvalidError("not found");
  if (session.claimedAt !== null) throw new GuestSessionInvalidError("claimed");
  if (session.expiresAt.getTime() <= now.getTime()) {
    throw new GuestSessionInvalidError("expired");
  }

  if (copyPreferences) {
    const parsed = GuestPreferencesSchema.safeParse(session.preferences ?? {});
    if (parsed.success) {
      const data = toUserPreferencesCreateData(parsed.data);
      // Always create the row, even when the guest set nothing: every other
      // signup path leaves the user without one and the resolvers cope, but a
      // guest who DID answer the wizard should not have to answer it again.
      await tx.userPreferences.create({ data: { userId, ...data } });
    } else {
      // A blob we cannot read is not a reason to fail a sign-up — the account
      // is the thing being created. Log it; the user keeps column defaults.
      logger.warn(
        {
          event: "guest_preferences_unreadable",
          guestSessionId,
          issues: parsed.error.issues.slice(0, 3),
        },
        "Guest preferences blob failed validation — new user keeps column defaults",
      );
    }
  }

  // 🔴 THE GUARDED UPDATE IS WHAT MAKES THE CLAIM SINGLE-USE. `claimedAt: null`
  // in the WHERE, and a count of 0 means someone else claimed this session
  // between the read above and here. Throwing rolls the whole signup back — so
  // the loser of that race gets a clean 409, not a half-made account.
  const marked = await tx.guestSession.updateMany({
    where: { id: guestSessionId, claimedAt: null },
    data: { claimedByUserId: userId, claimedAt: now, lastEvent: "claimed" },
  });
  if (marked.count === 0) throw new GuestSessionInvalidError("claimed");

  await tx.guestEvent.create({
    data: { guestSessionId, event: "claimed", meta: { userId } },
  });

  return { draft: session.draft ?? null };
}

// ── stage 1's compensating write (Block 1b Part A) ───────────────────────

/**
 * Row 13 · Block 1b — UNDO THE MARK when stage 2 failed.
 *
 * Block 1 shipped the two stages with no compensation between them, and the
 * gap is not cosmetic: stage 1 sets `claimedAt` / `claimedByUserId`, stage 2
 * builds the plan, and a stage-2 failure left the session PERMANENTLY claimed
 * with no plan to show for it. `claimGuestSessionInTx` refuses a session whose
 * `claimedAt` is non-null, so nothing — not a retry, not a later sign-in, not
 * support — could ever recover that visitor's plan. The failure was logged and
 * then made unrecoverable.
 *
 * So: clear the mark, narrowed to `claimedByUserId: userId`. That predicate is
 * the whole safety of this function. It releases only the claim THIS caller
 * just made, so a session some other user legitimately holds cannot be freed
 * by an unrelated failure, and the single-use guard is not loosened — it is
 * restored to the state it had before a claim that did not complete.
 *
 * The user's `UserPreferences` row and `onboardingComplete` are NOT rolled
 * back. They belong to the account, which exists and is correct; only the
 * session's claim is undone.
 *
 * Returns whether the release actually landed — the caller reports that to the
 * client as `claimRetryable`, so "you can try again" is a measured fact rather
 * than an assumption.
 */
export async function releaseClaimForRetry(opts: {
  prisma: PrismaClient;
  guestSessionId: string;
  userId: string;
}): Promise<boolean> {
  const { prisma, guestSessionId, userId } = opts;
  try {
    const released = await prisma.guestSession.updateMany({
      where: { id: guestSessionId, claimedByUserId: userId },
      data: {
        claimedAt: null,
        claimedByUserId: null,
        lastEvent: "claim_plan_failed",
      },
    });
    if (released.count === 0) {
      logger.warn(
        { event: "guest_claim_release_noop", guestSessionId, userId },
        "Nothing to release — the session is not claimed by this user",
      );
      return false;
    }
    // Funnel telemetry never sinks the funnel, and it certainly never undoes
    // the release above: the row is already free by the time this runs.
    await prisma.guestEvent
      .create({
        data: { guestSessionId, event: "claim_plan_failed", meta: { userId } },
      })
      .catch((err) => {
        logger.warn(
          { event: "guest_event_write_failed", guestSessionId, err },
          "Failed to write the claim_plan_failed guest event",
        );
      });
    return true;
  } catch (err) {
    // A failed release is bad but not fatal: the account is intact and the
    // only loss is the plan. Loud, because it is the one path that leaves a
    // session stuck claimed with nothing to show.
    logger.error(
      { event: "guest_claim_release_failed", guestSessionId, userId, err },
      "Could not release the guest claim after a failed plan build",
    );
    return false;
  }
}

// ── stage 2 ──────────────────────────────────────────────────────────────

export interface MaterializeClaimedDraftOptions {
  prisma: PrismaClient;
  userId: string;
  draft: unknown;
  /** The client's local calendar day, from the signup body. Optional. */
  localDate?: string;
  // DI seams, mirroring the wizard router's.
  runAICall?: typeof productionRunAICall;
  persistWizardDraft?: typeof productionPersistWizardDraft;
  readAndFinalizeWizardDraft?: typeof productionReadAndFinalize;
  materializeWizardDraft?: typeof productionMaterializeWizardDraft;
}

/**
 * Turn the guest's JSON draft into a real, dated, active plan for `userId`.
 *
 * Returns the plan id, or null if the draft could not be materialized — the
 * caller reports that as `claimedPlanId: null`, never as a failed sign-up.
 *
 * ⚠️ ZERO AI CALLS FOR A GUEST DRAFT, and by construction rather than by
 * hope: a guest draft is catalog-only (D-WS9-260), so every slot carries a
 * sourceStoreMealId, and wizardFinalize's own comment states the consequence —
 * "All-store plans skip finalize entirely — zero AI calls." A slot whose
 * catalog meal has since been unpublished demotes to a build slot and WOULD
 * finalize; that is the graceful-degrade path and it is correct to let it run
 * at claim time, when the user is real and the spend is a user's.
 */
export async function materializeClaimedDraft(
  opts: MaterializeClaimedDraftOptions,
): Promise<string | null> {
  const {
    prisma,
    userId,
    draft,
    runAICall = productionRunAICall,
    persistWizardDraft = productionPersistWizardDraft,
    readAndFinalizeWizardDraft = productionReadAndFinalize,
    materializeWizardDraft = productionMaterializeWizardDraft,
  } = opts;

  // The stored blob is { draft: { id, createdAt }, expanded } — the drafts-GET
  // shape. Only `expanded` matters here; the id was the session's.
  const envelope = draft as { expanded?: unknown } | null;
  const parsed = WizardExpandedPlanDetailsSchema.safeParse(envelope?.expanded);
  if (!parsed.success) {
    logger.warn(
      {
        event: "guest_claim_draft_malformed",
        userId,
        issues: parsed.error.issues.slice(0, 3),
      },
      "Guest draft blob failed schema parse at claim — no plan created",
    );
    return null;
  }
  const expanded = parsed.data;

  // 1. FIRST PERSIST. The same swappable seam the wizard route uses — the row
  //    is created for the REAL user, committed, because materialize's Pass 1
  //    re-reads it on the plain client.
  const contentHash = computeWizardContentHash(
    expanded.title,
    expanded.meals.map((m) => m.title),
  );
  const draftRef = await persistWizardDraft({
    prisma,
    userId,
    expanded,
    contentHash,
  });

  // 2. Finalize outside any transaction (see the header). Zero AI calls for an
  //    all-store plan.
  const finalized = await readAndFinalizeWizardDraft({
    prisma,
    userId,
    draftId: draftRef.planId,
    runAICall,
  });
  if (finalized.status !== "success") {
    logger.warn(
      {
        event: "guest_claim_finalize_failed",
        userId,
        draftId: draftRef.planId,
        status: finalized.status,
      },
      "Guest claim could not finalize the draft — no plan created",
    );
    return null;
  }

  // 3. Materialize + activate, in the same shape POST /wizard/drafts/:id/
  //    activate uses, including its transaction budget. The plan is for THIS
  //    week with its first dinner tomorrow.
  const today = todayFor(opts.localDate);
  const result = await prisma.$transaction(
    async (tx) => {
      const materialized = await materializeWizardDraft({
        prisma,
        tx,
        userId,
        draftId: draftRef.planId,
        savePlan: finalized.savePlan,
        dayAssignment: { startDate: addUtcDays(today, 1) },
      });
      const range = activeWindowFromToday(today, materialized.assignedDays ?? []);
      const priorWinnerId = await resolveThisWeekWinnerId(tx, userId);
      const activated = await tx.mealPlanInstance.update({
        where: { id: draftRef.planId },
        data: {
          isWizardDraft: false,
          revisionId: { increment: 1 },
          startDate: range.startDate,
          endDate: range.endDate,
          activatedAt: new Date(),
          committedAt: new Date(),
          mealPlanTemplateId: materialized.mealPlanTemplateId,
          wizardDraftPayload: Prisma.DbNull,
          optimizationNotes: Prisma.DbNull,
        },
        select: { id: true },
      });
      // D-WS9-026 — the Home teaching-arc collapse signal. A claimed guest
      // plan IS the account's first plan, which is exactly what this records.
      await markFirstPlanCreated(tx, userId);
      await emitActivity({
        tx,
        userId,
        eventType: "plan_activated_this_week",
        entityType: "MealPlanInstance",
        entityId: activated.id,
        metadata: {
          source: "guest_claim",
          mealsCreated: materialized.mealsCreated,
          itemsCreated: materialized.itemsCreated,
          priorWinnerId,
        },
      });
      return activated.id;
    },
    // The activate route's measured budget, for the same work: a CONFIRM run
    // measured the un-clamped tx at ~17 s on a 17-dish input.
    { timeout: 60_000, maxWait: 20_000 },
  );

  return result;
}

// ── the templatePlanId half (scope §3.7) ─────────────────────────────────

export interface AdoptTemplateOptions {
  prisma: PrismaClient;
  userId: string;
  templateId: string;
  localDate?: string;
}

/**
 * "Sign up and use this week" on the published weekly plan: copy the featured
 * template into the new account and date it for this week.
 *
 * Reuses the use-template copy verbatim (lib/planFromTemplate.ts) and then
 * dates the undated instance, which is the one thing that route leaves to its
 * caller. Returns null when the template is not visible — a bad
 * `templatePlanId` never fails a sign-up.
 */
export async function adoptTemplateForUser(
  opts: AdoptTemplateOptions,
): Promise<string | null> {
  const { prisma, userId, templateId } = opts;
  const today = todayFor(opts.localDate);
  try {
    return await prisma.$transaction(async (tx) => {
      const copied = await copyTemplateForUser(
        tx,
        templateId,
        userId,
        markFirstPlanCreated,
      );
      if (copied.kind === "not_found") return null;
      // The copy is undated by design (WS7-6 E). Date it from tomorrow, the
      // same window the wizard activate path opens.
      const start = addUtcDays(today, 1);
      await tx.mealPlanInstance.update({
        where: { id: copied.instance.id },
        data: {
          startDate: start,
          endDate: addUtcDays(start, 6),
          activatedAt: new Date(),
        },
      });
      return copied.instance.id;
    });
  } catch (err) {
    logger.error(
      { event: "guest_claim_template_failed", userId, templateId, err },
      "Could not adopt the template at sign-up — account created without it",
    );
    return null;
  }
}
