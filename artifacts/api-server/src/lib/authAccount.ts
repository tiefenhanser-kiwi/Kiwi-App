// Row 9 (1.1) · OAuth Block 1 Part D — THE TWO THINGS EVERY DOOR DOES.
//
// There are now four ways into an account: password sign-up, password
// sign-in, Continue with Apple, Continue with Google. They differ in exactly
// one thing — how the person proved who they are — and agree on everything
// after: create the user with a Subscription row, claim the guest session in
// the same transaction, and then, after that transaction commits, build the
// claimed plan.
//
// §2.7 of the commission said to extract a shared helper rather than copy the
// sign-up's code into the OAuth routes, and this is that extraction. It is not
// speculative generality: BOTH functions below already had TWO call sites in
// routes/auth.ts before this block (sign-up and sign-in ran near-identical
// stage-2 blocks, right down to the compensating release), and this takes them
// to four. Every behaviour here is behaviour that shipped in Row 13 · Block 1
// and 1b; what changed is that there is now one copy of it.
//
// ── THE SEAM BETWEEN THE STAGES IS NOT NEGOTIABLE ────────────────────────
//
// Read lib/guestClaim.ts's header for the full argument. In one line:
// `materializeWizardDraft` needs the draft row COMMITTED before it can read
// it, so the plan cannot be built inside the transaction that creates the
// account — and a plan failure must never throw away a sign-up the visitor has
// already committed to. Stage 1 is atomic; stage 2 compensates.

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  adoptTemplateForUser,
  claimGuestSessionInTx,
  materializeClaimedDraft as productionMaterializeClaimedDraft,
  releaseClaimForRetry,
} from "./guestClaim";
import { logger } from "./logger";

// WS9-2 — the free-trial length. MOVED here from routes/auth.ts with the
// account creation it stamps; the route re-exports it so nothing that imported
// it from there breaks.
// ⚠️ KEEP IN SYNC with the mobile copy: artifacts/kiwi/lib/domain.ts has its
// own `TRIAL_LENGTH_DAYS` (separate package, no cheap shared module).
export const TRIAL_LENGTH_DAYS = 14;

export interface CreateAccountInput {
  tx: Prisma.TransactionClient;
  email: string;
  /** Null for an OAuth-only account. The column has been nullable since before this block. */
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  zipCode?: string | null;
  timezone?: string | null;
  phone?: string | null;
  marketingConsentEmail?: boolean | undefined;
  marketingConsentSms?: boolean | undefined;
  /** D-WS9-264. Resolved by the caller; a guest claim overrides the client's `platform`. */
  signupSource: string | null;
  guestSessionId?: string | undefined;
  trialEndsAt?: Date;
}

export interface CreatedAccount {
  user: Awaited<ReturnType<Prisma.TransactionClient["user"]["create"]>> & {
    onboardingComplete: boolean;
  };
  subscription: Awaited<ReturnType<Prisma.TransactionClient["subscription"]["create"]>>;
  /** The blob stage 2 will materialize, or null. */
  claimedDraft: unknown;
}

/**
 * STAGE 1, and it must be called INSIDE a `$transaction`: the account, its
 * Subscription row, the guest preferences copy and the session marked claimed
 * either all happen or none do. A `GuestSessionInvalidError` thrown by the
 * claim rolls the whole thing back, which is what stops a half-made account
 * surviving a stale session.
 */
export async function createAccountInTx(input: CreateAccountInput): Promise<CreatedAccount> {
  const { tx, guestSessionId } = input;
  const trialEndsAt =
    input.trialEndsAt ?? new Date(Date.now() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000);

  const newUser = await tx.user.create({
    data: {
      email: input.email,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      zipCode: input.zipCode ?? null,
      timezone: input.timezone ?? "America/New_York",
      phone: input.phone ?? null,
      // Only written when the caller actually has them — an absent flag keeps
      // the Prisma default (false), same as onboardingComplete below.
      ...(input.marketingConsentEmail !== undefined
        ? { marketingConsentEmail: input.marketingConsentEmail }
        : {}),
      ...(input.marketingConsentSms !== undefined
        ? { marketingConsentSms: input.marketingConsentSms }
        : {}),
      signupSource: input.signupSource,
    },
  });

  const subscription = await tx.subscription.create({
    data: { userId: newUser.id, planCode: "free", status: "trialing", trialEndsAt },
  });

  let onboardingComplete = newUser.onboardingComplete;
  let claimedDraft: unknown = null;
  if (guestSessionId) {
    const claim = await claimGuestSessionInTx({
      tx,
      guestSessionId,
      userId: newUser.id,
      // A brand-new account: the guest's wizard answers ARE its preferences.
      copyPreferences: true,
    });
    claimedDraft = claim.draft;
    // ── R1 / D-WS9-263 — THE CLAIM COMPLETES ONBOARDING. ───────────────────
    // The account already holds the answers the onboarding form would ask for,
    // so sending them to it would be asking twice and showing them an empty
    // copy of what they just filled in. Gated on `preferencesCopied`, never on
    // `guestSessionId` alone: an unreadable blob leaves the user on column
    // defaults, which is exactly the state onboarding exists to fix.
    //
    // A SECOND WRITE, and it has to be: the decision depends on the claim's
    // result, and the claim needs `newUser.id`. Same transaction, so an account
    // is never committed with onboardingComplete out of step with its
    // preferences row.
    if (claim.preferencesCopied) {
      const flagged = await tx.user.update({
        where: { id: newUser.id },
        data: { onboardingComplete: true },
        select: { onboardingComplete: true },
      });
      onboardingComplete = flagged.onboardingComplete;
    }
  }

  return { user: { ...newUser, onboardingComplete }, subscription, claimedDraft };
}

export interface FinishClaimInput {
  prisma: PrismaClient;
  userId: string;
  guestSessionId?: string | undefined;
  templatePlanId?: string | undefined;
  /** From stage 1 (sign-up) or from the sign-in claim. Null = nothing to build. */
  claimedDraft: unknown;
  localDate?: string | undefined;
  materializeClaimedDraft?: typeof productionMaterializeClaimedDraft;
  /** For the log line, so sign-up and sign-in stay distinguishable in Cloud Logging. */
  via: string;
}

export interface FinishClaimResult {
  claimedPlanId: string | null;
  claimRetryable: boolean;
}

/**
 * STAGE 2, and deliberately OUTSIDE the transaction. A failure here leaves a
 * perfectly good account with no plan and SAYS SO, rather than throwing away a
 * sign-up the visitor has already made.
 *
 * On failure it COMPENSATES first and logs second (Block 1b Part A): Block 1
 * logged and stopped, which left the session claimed forever — every later
 * attempt hit the `claimedAt: null` guard and the visitor's plan was gone for
 * good. Releasing the mark lets the next sign-in with the same guestSessionId
 * claim it again and succeed.
 */
export async function finishClaimAfterCommit(
  input: FinishClaimInput,
): Promise<FinishClaimResult> {
  const { prisma, userId, guestSessionId, templatePlanId, claimedDraft, localDate } = input;
  const materialize = input.materializeClaimedDraft ?? productionMaterializeClaimedDraft;

  if (guestSessionId && claimedDraft) {
    try {
      return {
        claimedPlanId: await materialize({ prisma, userId, draft: claimedDraft, localDate }),
        claimRetryable: false,
      };
    } catch (err) {
      const claimRetryable = await releaseClaimForRetry({ prisma, guestSessionId, userId });
      logger.error(
        { event: "guest_claim_plan_failed", via: input.via, userId, guestSessionId, claimRetryable, err },
        "Guest claim could not build the plan — the account is unaffected",
      );
      // Both nulls stay indistinguishable for NAVIGATION (the client goes to
      // the plan when there is one and Home when there is not); `claimRetryable`
      // is the one thing a client may want to tell apart.
      return { claimedPlanId: null, claimRetryable };
    }
  }

  if (templatePlanId) {
    return {
      claimedPlanId: await adoptTemplateForUser({ prisma, userId, templateId: templatePlanId, localDate }),
      claimRetryable: false,
    };
  }

  return { claimedPlanId: null, claimRetryable: false };
}
