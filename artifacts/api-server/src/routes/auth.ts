import { Router, type IRouter, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";
import { createRequireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import { phoneSchema } from "../lib/phoneValidation";
import {
  buildAppLink,
  passwordResetMessage,
  sendEmail as productionSendEmail,
  type EmailSender,
} from "../lib/email/sendEmail";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { isIssuedBeforeEpoch, redeemPurposeToken } from "../lib/tokenRevocation";
import {
  claimGuestSessionInTx,
  GuestSessionInvalidError,
  materializeClaimedDraft as productionMaterializeClaimedDraft,
} from "../lib/guestClaim";
// Row 9 · OAuth Block 1 Part D — the account-creation and claim-stage-2 code
// that sign-up and sign-in used to hold inline. Extracted, not copied: the two
// OAuth routes below are the third and fourth callers (§2.7).
import { createAccountInTx, finishClaimAfterCommit } from "../lib/authAccount";
import { readOAuthConfig, type OAuthConfig } from "../lib/oauth/config";
import {
  exchangeAppleAuthorizationCode as productionExchangeAppleCode,
  productionAppleFetch,
} from "../lib/oauth/appleTokens";
import { encryptSecret } from "../lib/oauth/secretBox";
import {
  claimForExistingUser,
  isIdentityRaceLoss,
  resolveIdentity,
  type IdentityLinkFacts,
} from "../lib/oauth/resolve";
import {
  productionAppleJwksCache,
  productionGoogleJwksCache,
  verifyAppleIdentityToken,
  verifyGoogleIdentityToken,
  type IdentityVerdict,
  type OAuthProviderName,
} from "../lib/oauth/verify";

// Tight limiter for signup/login to slow brute-force attempts
const authLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 }); // 10 burst, ~1/6s
// Looser limiter for /me (read-only, auth'd)
const meLimiter = rateLimit({ capacity: 30, refillPerSec: 30 / 60 });
// Even tighter for password reset request (prevents email enumeration via rate patterns)
const resetLimiter = rateLimit({ capacity: 5, refillPerSec: 5 / 300 }); // 5 burst, ~1/60s


// Password-reset tokens are short-lived per WS7-2 Block A. Reuses the
// session signing helper with purpose='password_reset' so a leaked reset
// token can't be replayed as a session.
const PASSWORD_RESET_EXPIRY = "1h";

// Row 13 · Block 1 — shared by signup and login so the two cannot drift.
// `localDate` rides along for the same reason POST /wizard/drafts/:id/activate
// takes one: the claimed plan's first dinner is TOMORROW in the visitor's
// calendar, not tomorrow UTC.
const GUEST_CLAIM_FIELDS = {
  guestSessionId: z.string().min(1).max(100).optional(),
  templatePlanId: z.string().min(1).max(100).optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
} as const;

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(100),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  zipCode: z.string().max(20).optional(),
  timezone: z.string().max(100).optional(),
  // D-WS9-241 A (BUG-261) — phone + marketing consents ride the signup wire
  // so the account is created with them in ONE write (a follow-up PATCH
  // /me/profile was rejected: the second write can fail silently, and a
  // consent that may or may not have landed is worse than none). The phone
  // rule is the same object PATCH /me/profile validates with. Columns exist
  // since D-WS7-025; PATCH /me/profile stays the edit path.
  phone: phoneSchema.nullable().optional(),
  marketingConsentEmail: z.boolean().optional(),
  marketingConsentSms: z.boolean().optional(),
  // Row 13 · Block 1b / D-WS9-264 — where this account came from. Hans: "mark
  // the entry point of the user somehow so I can add them into an onboarding
  // campaign that alerts them of the mobile app. and vice versa."
  //
  // OPTIONAL, and absent means null, not a guess: every client shipped before
  // this sends nothing, and inferring a platform from the User-Agent would
  // write a fact nobody asserted into a column marketing will segment on.
  // A `guestSessionId` on the body OVERRIDES this — see the resolution below.
  platform: z.enum(["web", "ios", "android"]).optional(),
  // Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — THE CLAIM. Both optional,
  // MUTUALLY EXCLUSIVE, and both are the same sentence in different words:
  // "keep what I just made."
  //   guestSessionId  — the Test Kitchen plan this visitor built (§3.4)
  //   templatePlanId  — "sign up and use this week" on the published weekly
  //                     plan (§3.7)
  ...GUEST_CLAIM_FIELDS,
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(100),
  // Row 13 · Block 1 — a returning user can claim too: they walked the Test
  // Kitchen, liked the plan, and turn out to already have an account. Same
  // claim, minus the preferences copy (see lib/guestClaim.ts's header).
  ...GUEST_CLAIM_FIELDS,
});

// ── Row 9 (1.1) · OAuth Block 1 Part D — the two social sign-in bodies ────
//
// Everything a password SIGN-UP may send rides here too, and for one reason:
// an OAuth sign-in that turns out to be a first sign-in IS a sign-up. PRD §3.3
// shows the consent checkboxes on the OAuth sign-up screen, so the consents
// have to be on this wire or they would have to be a second PATCH — the write
// that D-WS9-241 A already rejected, because a consent that may or may not
// have landed is worse than none.
//
// They are IGNORED for an existing user. Someone signing in for the twentieth
// time is not re-stating their marketing preferences, and letting a sign-in
// body overwrite them would make every launch of the app a silent consent
// update.
const OAUTH_SHARED_FIELDS = {
  // Apple hands the name to the CLIENT on the first authorisation and never
  // again, so the client forwards what it was given. Never trusted for
  // anything but display, and never applied to an account that already exists.
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  zipCode: z.string().max(20).optional(),
  timezone: z.string().max(100).optional(),
  phone: phoneSchema.nullable().optional(),
  marketingConsentEmail: z.boolean().optional(),
  marketingConsentSms: z.boolean().optional(),
  platform: z.enum(["web", "ios", "android"]).optional(),
  ...GUEST_CLAIM_FIELDS,
} as const;

const appleOAuthSchema = z.object({
  identityToken: z.string().min(1).max(8000),
  // The PRE-HASH value. Apple's token carries sha256hex of it; the server
  // recomputes and compares. See lib/oauth/verify.ts's header for the exact
  // encoding the client must use.
  rawNonce: z.string().min(1).max(500),
  // OPTIONAL, and its absence never blocks a sign-in. It is the one-time code
  // Apple returns beside the identity token; exchanging it is what yields the
  // refresh token that DELETE /me needs to revoke (App Review 5.1.1(v)).
  authorizationCode: z.string().min(1).max(2000).optional(),
  ...OAUTH_SHARED_FIELDS,
});

const googleOAuthSchema = z.object({
  idToken: z.string().min(1).max(8000),
  ...OAUTH_SHARED_FIELDS,
});

const resetRequestSchema = z.object({
  email: z.string().email().max(255),
});

const resetConfirmSchema = z.object({
  token: z.string().min(10).max(500),
  newPassword: z.string().min(8).max(100),
});

function toUserShape(u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  marketingConsentEmail: boolean;
  marketingConsentSms: boolean;
  onboardingComplete: boolean;
  firstRunChoiceMade: boolean;
  // Row 13 · Block 1b B2 — D-WS9-264 / D-WS9-263. REQUIRED on the input type,
  // not optional: a caller whose `select` forgets a column then fails to
  // typecheck instead of quietly serialising undefined into the wire shape.
  signupSource: string | null;
  personalizeNudgeDismissedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    zipCode: u.zipCode,
    timezone: u.timezone,
    accountStatus: u.accountStatus,
    subscriptionStatus: u.subscriptionStatus,
    defaultHouseholdSize: u.defaultHouseholdSize,
    lastPlanDiscoveryFilters: u.lastPlanDiscoveryFilters,
    lastPlansFilters: u.lastPlansFilters,
    lastMealsFilters: u.lastMealsFilters,
    marketingConsentEmail: u.marketingConsentEmail,
    marketingConsentSms: u.marketingConsentSms,
    onboardingComplete: u.onboardingComplete,
    firstRunChoiceMade: u.firstRunChoiceMade,
    // D-WS9-264 — read-only after signup; no route updates it.
    signupSource: u.signupSource,
    // D-WS9-263 — ISO or null, like its siblings firstPlanCreatedAt /
    // playlistCtaTappedAt. `IS NULL` is the gate; the value says when.
    personalizeNudgeDismissedAt:
      u.personalizeNudgeDismissedAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

function toSubscriptionShape(s: {
  status: string;
  planCode: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}) {
  return {
    status: s.status,
    planCode: s.planCode,
    trialEndsAt: s.trialEndsAt ? s.trialEndsAt.toISOString() : null,
    currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null,
  };
}

export interface AuthRouterDeps {
  prisma: PrismaClient;
  /** BUG-224 — injected so tests record instead of sending. See lib/email. */
  sendEmail: EmailSender;
  /**
   * Row 13 · Block 1b — stage 2 of the claim, on the computePlanMacros /
   * estimateDishMacros DI pattern. Injected so a test can make the plan build
   * FAIL and assert the compensating release (Part A), which is otherwise
   * unreachable from a router test: stage 2 is a four-call pipeline over the
   * real wizard primitives, and driving it to a controlled throw through a stub
   * Prisma would be asserting on an incidental TypeError rather than on the
   * contract. The seam is the whole stage, not its inner
   * `materializeWizardDraft`, because that is the function this route calls —
   * threading the inner one would add four pass-through deps for no coverage.
   */
  materializeClaimedDraft: typeof productionMaterializeClaimedDraft;
  /**
   * Row 9 · OAuth Block 1 Part C — THE SEAM THAT KEEPS THE SUITE HERMETIC.
   *
   * `pnpm test` runs with `--env-file=.env`. A default that reached Apple's or
   * Google's live JWKS endpoint would put a real outbound request one
   * forgotten stub away from every router test in this file, and a flaky
   * network would then read as a broken auth route. Tests inject a verifier
   * over a locally generated key pair; production passes the real one.
   *
   * The seam is the WHOLE verification, not the JWKS fetch inside it, because
   * that is what the route calls — threading the fetch would leave the caches,
   * the issuer lists and the nonce rule on the production path anyway.
   */
  verifyApple: (opts: {
    identityToken: string | undefined;
    rawNonce: string | undefined;
    audiences: readonly string[];
  }) => Promise<IdentityVerdict>;
  verifyGoogle: (opts: {
    idToken: string | undefined;
    clientIds: readonly string[];
  }) => Promise<IdentityVerdict>;
  /** Read once per router so a test can hand in a configured or unconfigured deploy. */
  oauthConfig: OAuthConfig;
  /**
   * Row 9 · OAuth Block 1 Part E — the one-time code → refresh token exchange
   * at appleid.apple.com. Same reason as the verifiers: the suite loads .env
   * and a default-on live POST is one forgotten stub from every test here.
   */
  exchangeAppleCode: typeof productionExchangeAppleCode;
}

export function createAuthRouter(deps: Partial<AuthRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const materializeClaimedDraft =
    deps.materializeClaimedDraft ?? productionMaterializeClaimedDraft;
  // Read ONCE at router construction, not per request: a Cloud Run env change
  // is a new revision anyway, so a per-request read would buy nothing and
  // would make the boot line (logOAuthConfig, app.ts) a different answer from
  // the one the routes actually use.
  const oauthConfig = deps.oauthConfig ?? readOAuthConfig();
  const verifyApple =
    deps.verifyApple ??
    ((opts) =>
      verifyAppleIdentityToken({ ...opts, cache: productionAppleJwksCache() }));
  const verifyGoogle =
    deps.verifyGoogle ??
    ((opts) =>
      verifyGoogleIdentityToken({ ...opts, cache: productionGoogleJwksCache() }));
  const exchangeAppleCode = deps.exchangeAppleCode ?? productionExchangeAppleCode;
  // WS9A BUG-234 — the session guard now reads User.tokensValidFrom, so it
  // needs a Prisma client. Building it from the injected one (rather than
  // importing the singleton) is what keeps this router's tests hermetic.
  // Shadows the module import: every requireAuth call site below is unchanged.
  const requireAuth = createRequireAuth({ prisma });
  const sendEmail = deps.sendEmail ?? productionSendEmail;
  const router: IRouter = Router();

  // POST /auth/signup
  router.post("/auth/signup", authLimiter, async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const {
      email,
      password,
      firstName,
      lastName,
      zipCode,
      timezone,
      phone,
      marketingConsentEmail,
      marketingConsentSms,
      platform,
      guestSessionId,
      templatePlanId,
      localDate,
    } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // D-WS9-241 A — a consent that cannot be honoured is not a consent.
    if (marketingConsentSms && !phone) {
      return res
        .status(400)
        .json({ error: "SMS consent requires a phone number" });
    }

    // Row 13 · Block 1 — the two claims are different plans from different
    // places; asking for both is a client bug, not a merge to guess at.
    if (guestSessionId && templatePlanId) {
      return res.status(400).json({
        error: "guestSessionId and templatePlanId are mutually exclusive",
      });
    }

    try {
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return res.status(400).json({ error: "email already registered" });
      }

      const passwordHash = await hashPassword(password);

      // Row 13 · Block 1 (D-WS9-259) — STAGE 1 OF THE CLAIM rides inside the
      // same transaction as the account: the preferences copy and the session
      // marked claimed, so an account created from a guest session is never
      // created without them. Stage 2 (the plan itself) CANNOT be in here —
      // see the long note at the top of lib/guestClaim.ts. A
      // GuestSessionInvalidError rolls the whole thing back and the catch below
      // maps it to 409.
      //
      // Row 9 · OAuth Block 1 Part D — the body of this transaction MOVED to
      // lib/authAccount.ts so the two OAuth routes create accounts the same
      // way this one does, rather than through a copy free to drift from it.
      // Behaviour is unchanged; what changed is that there is one copy of it.
      const created = await prisma.$transaction((tx) =>
        createAccountInTx({
          tx,
          email: normalizedEmail,
          passwordHash,
          firstName,
          lastName,
          zipCode,
          timezone,
          phone,
          marketingConsentEmail,
          marketingConsentSms,
          // D-WS9-264 — the entry point, resolved HERE and written once. A
          // guestSessionId wins over `platform` because it is the more specific
          // fact: the Test Kitchen runs on the web, so a body with both would
          // otherwise record "web" and lose the funnel this column exists to
          // name. Null when neither is present.
          signupSource: guestSessionId ? "test_kitchen" : (platform ?? null),
          guestSessionId,
        }),
      );
      const user = { ...created.user, subscription: created.subscription };

      // ── STAGE 2. After the commit, and deliberately outside it. ─────────
      const { claimedPlanId, claimRetryable } = await finishClaimAfterCommit({
        prisma,
        userId: user.id,
        guestSessionId,
        templatePlanId,
        claimedDraft: created.claimedDraft,
        localDate,
        materializeClaimedDraft,
        via: "signup",
      });

      const token = signToken(user.id);
      logger.info(
        {
          userId: user.id,
          guestSessionId: guestSessionId ?? null,
          templatePlanId: templatePlanId ?? null,
          claimedPlanId,
        },
        "User signed up",
      );
      return res.status(201).json({
        user: {
          ...toUserShape(user),
          subscription: toSubscriptionShape(user.subscription),
        },
        authToken: token,
        // R1 / D-WS9-263 — DERIVED, never a literal. This was hard-coded `true`
        // since the route was written, which was correct while every signup
        // path led to the form; a Test Kitchen claim is the first one that does
        // not, and a literal here would have sent exactly those users to an
        // empty copy of the form they had just filled in.
        onboardingRequired: !user.onboardingComplete,
        // Row 13 · Block 1 — null when nothing was claimed, AND null when a
        // claim was asked for but the plan could not be built. The client
        // navigates to the plan when this is set and to Home when it is not;
        // it never has to distinguish the two nulls.
        claimedPlanId,
        // Row 13 · Block 1b Part A — the two nulls above stay indistinguishable
        // for navigation, and THIS is the one thing a client may want to tell
        // apart: true means the session was released and re-claiming it (by
        // signing in with the same guestSessionId) will build the plan. False
        // covers "nothing was claimed", "the draft was malformed" (a retry
        // reproduces the same malformed draft) and "the release itself failed".
        claimRetryable,
      });
    } catch (err) {
      // Row 13 · Block 1 — a session that is missing, expired or already
      // claimed is the CLIENT's state being stale, not a server failure, and
      // the rollback means no half-made account survives it.
      if (err instanceof GuestSessionInvalidError) {
        logger.info(
          { event: "guest_claim_refused", guestSessionId, detail: err.detail },
          "Signup refused: the guest session could not be claimed",
        );
        return res.status(409).json({ code: "guest_session_invalid" });
      }
      logger.error({ err }, "Signup failed");
      return res.status(500).json({ error: "signup failed" });
    }
  });

  // POST /auth/login
  router.post("/auth/login", authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { email, password, guestSessionId, templatePlanId, localDate } =
      parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    if (guestSessionId && templatePlanId) {
      return res.status(400).json({
        error: "guestSessionId and templatePlanId are mutually exclusive",
      });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { subscription: true },
      });
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "invalid credentials" });
      }
      if (user.accountStatus !== "active") {
        return res.status(403).json({ error: "account not active" });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "invalid credentials" });
      }

      // Update last-login tracking. Non-critical if this fails — don't block login.
      await prisma.user
        .update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            loginCountTotal: { increment: 1 },
          },
        })
        .catch((err) => {
          logger.warn({ err, userId: user.id }, "Failed to update login tracking");
        });

      // ── Row 13 · Block 1 — the sign-in claim. ───────────────────────────
      //
      // Steps 3→8 of the signup claim, MINUS THE PREFERENCES COPY. This user
      // already has preferences — possibly months of them — and a guest blob
      // typed into a public demo must never replace their allergy list. The
      // plan follows them; nothing else does.
      let claimedDraft: unknown = null;
      if (guestSessionId) {
        try {
          const claim = await prisma.$transaction(async (tx) =>
            claimGuestSessionInTx({
              tx,
              guestSessionId,
              userId: user.id,
              copyPreferences: false,
            }),
          );
          claimedDraft = claim.draft;
        } catch (err) {
          if (err instanceof GuestSessionInvalidError) {
            // 🔴 LOGGED, NOT REFUSED — the asymmetry with signup is deliberate.
            // At signup the account did not exist and the 409 costs nothing.
            // Here the credentials are already verified, and refusing a valid
            // login because a demo session went stale would lock someone out
            // of their own account over a cosmetic failure.
            logger.info(
              {
                event: "guest_claim_refused",
                userId: user.id,
                guestSessionId,
                detail: err.detail,
              },
              "Login proceeded; the guest session could not be claimed",
            );
          } else {
            throw err;
          }
        }
      }
      // Row 9 · OAuth Block 1 Part D — stage 2, through the same helper the
      // sign-up uses. The compensation matters MORE here than there: a
      // returning user who claims, fails, and signs in again is the single most
      // likely retry there is, and without the release every one of those
      // attempts would be refused by the `claimedAt: null` guard.
      const { claimedPlanId, claimRetryable } = await finishClaimAfterCommit({
        prisma,
        userId: user.id,
        guestSessionId,
        templatePlanId,
        claimedDraft,
        localDate,
        materializeClaimedDraft,
        via: "login",
      });

      const token = signToken(user.id);
      logger.info(
        { userId: user.id, claimedPlanId },
        "User logged in",
      );
      return res.json({
        user: {
          ...toUserShape(user),
          subscription: user.subscription
            ? toSubscriptionShape(user.subscription)
            : null,
        },
        authToken: token,
        claimedPlanId,
        // Row 13 · Block 1b Part A — same meaning as on signup.
        claimRetryable,
      });
    } catch (err) {
      logger.error({ err }, "Login failed");
      return res.status(500).json({ error: "login failed" });
    }
  });

  // ── Row 9 (1.1) · OAuth Block 1 Part D — the two social sign-in doors ───
  //
  // ONE BODY, and it is both a sign-up and a sign-in. Which one it turns out
  // to be is not the client's to declare: `resolveIdentity` decides from the
  // verified token, and `isNewUser` on the response is the report of what
  // happened. A client that asked for "sign up" and was recognised gets signed
  // in, which is the only behaviour a person tapping one button expects.
  //
  // ⚠️ ONE GENERIC 401 FOR EVERY VERIFICATION FAILURE (§2.8). A wrong
  // audience, an expired token, a bad signature, a nonce mismatch and an
  // unverified email all answer the same three bytes. The reason goes to the
  // log, where it is diagnosable, and not to the wire, where it would tell an
  // attacker which of their guesses was closest.

  interface OAuthHandlerArgs {
    provider: OAuthProviderName;
    verdict: IdentityVerdict;
    body: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      zipCode?: string | undefined;
      timezone?: string | undefined;
      phone?: string | null | undefined;
      marketingConsentEmail?: boolean | undefined;
      marketingConsentSms?: boolean | undefined;
      platform?: "web" | "ios" | "android" | undefined;
      guestSessionId?: string | undefined;
      templatePlanId?: string | undefined;
      localDate?: string | undefined;
    };
    /** Part E fills this in for Apple; null everywhere else. */
    appleRefreshTokenEnc?: string | null;
    res: Response;
  }

  async function completeOAuthSignIn(args: OAuthHandlerArgs) {
    const { provider, verdict, body, res } = args;

    if (!verdict.ok) {
      logger.warn(
        { event: "oauth_verify_failed", provider, reason: verdict.reason, detail: verdict.detail },
        "OAuth identity token refused",
      );
      // `not_configured` cannot reach here — the route checks the audience
      // list before verifying — but if it ever did, 401 is the safe answer.
      return res.status(401).json({ error: "invalid credentials" });
    }
    const identity = verdict.identity;

    const { guestSessionId, templatePlanId, localDate } = body;
    if (guestSessionId && templatePlanId) {
      return res.status(400).json({
        error: "guestSessionId and templatePlanId are mutually exclusive",
      });
    }

    const linkFacts: IdentityLinkFacts = {
      emailAtLink: identity.email,
      emailVerified: identity.emailVerified,
      isPrivateRelay: identity.isPrivateRelay,
      appleClientId: provider === "apple" ? identity.audience : null,
      appleRefreshTokenEnc: args.appleRefreshTokenEnc ?? null,
    };

    const resolveOnce = () =>
      resolveIdentity({
        prisma,
        identity,
        bodyFirstName: body.firstName,
        bodyLastName: body.lastName,
        zipCode: body.zipCode,
        timezone: body.timezone,
        phone: body.phone,
        marketingConsentEmail: body.marketingConsentEmail,
        marketingConsentSms: body.marketingConsentSms,
        platform: body.platform,
        guestSessionId,
        linkFacts,
      });

    let outcome;
    try {
      outcome = await resolveOnce();
    } catch (err) {
      // The unique index on (provider, subject) is the race guard: two
      // simultaneous first sign-ins with the same token cannot both create an
      // account. The loser retries ONCE and takes branch (a), which is now
      // true. A second P2002 is a real failure and propagates.
      if (!isIdentityRaceLoss(err)) throw err;
      logger.info(
        { event: "oauth_identity_race", provider },
        "Concurrent first sign-in for the same identity — retrying as an existing one",
      );
      outcome = await resolveOnce();
    }

    if (!outcome.ok) {
      logger.warn(
        { event: "oauth_resolve_refused", provider, reason: outcome.reason },
        "OAuth sign-in refused after verification",
      );
      return res.status(401).json({ error: "invalid credentials" });
    }

    // ── the claim (§2.7) ──────────────────────────────────────────────────
    // A NEW user's claim already ran inside `resolveIdentity`'s transaction
    // (preferences copied, onboarding completed). An EXISTING user claims here
    // and copies NOTHING but the plan — a guest blob typed into a public demo
    // must never replace an established account's allergy list.
    let claimedDraft = outcome.claimedDraft;
    if (!outcome.isNewUser && guestSessionId) {
      try {
        claimedDraft = await claimForExistingUser({
          prisma,
          guestSessionId,
          userId: outcome.userId,
        });
      } catch (err) {
        if (!(err instanceof GuestSessionInvalidError)) throw err;
        // LOGGED, NOT REFUSED — the same asymmetry password login has. The
        // identity is already verified, and refusing a valid sign-in because a
        // demo session went stale would lock someone out of their own account
        // over a cosmetic failure.
        logger.info(
          { event: "guest_claim_refused", provider, userId: outcome.userId, detail: err.detail },
          "OAuth sign-in proceeded; the guest session could not be claimed",
        );
      }
    }

    const { claimedPlanId, claimRetryable } = await finishClaimAfterCommit({
      prisma,
      userId: outcome.userId,
      guestSessionId,
      templatePlanId,
      claimedDraft,
      localDate,
      materializeClaimedDraft,
      via: `oauth_${provider}`,
    });

    // Re-read rather than thread the created row out: `resolveIdentity` has
    // three exits and only one of them holds a user object, and the claim above
    // may have flipped `onboardingComplete` since. One query, one shape.
    const user = await prisma.user.findUnique({
      where: { id: outcome.userId },
      include: { subscription: true },
    });
    if (!user) {
      logger.error({ event: "oauth_user_vanished", provider, userId: outcome.userId }, "OAuth user missing after resolve");
      return res.status(500).json({ error: "sign-in failed" });
    }
    if (user.accountStatus !== "active") {
      return res.status(403).json({ error: "account not active" });
    }

    if (!outcome.isNewUser) {
      // Same non-critical tracking password login does; a failure never blocks.
      await prisma.user
        .update({
          where: { id: user.id },
          data: { lastLoginAt: new Date(), loginCountTotal: { increment: 1 } },
        })
        .catch((err) => {
          logger.warn({ err, userId: user.id }, "Failed to update login tracking");
        });
    }

    logger.info(
      {
        event: "oauth_sign_in",
        provider,
        userId: user.id,
        isNewUser: outcome.isNewUser,
        identityCreated: outcome.identityCreated,
        isPrivateRelay: identity.isPrivateRelay,
        guestSessionId: guestSessionId ?? null,
        claimedPlanId,
      },
      `Signed in with ${provider}`,
    );

    return res.status(outcome.isNewUser ? 201 : 200).json({
      user: {
        ...toUserShape(user),
        subscription: user.subscription ? toSubscriptionShape(user.subscription) : null,
      },
      authToken: signToken(user.id),
      // DERIVED, never a literal — an OAuth sign-up that claimed a Test Kitchen
      // session already has its preferences and must not be sent to an empty
      // copy of the form it just filled in (R1 / D-WS9-263).
      onboardingRequired: !user.onboardingComplete,
      claimedPlanId,
      claimRetryable,
      // §2.8 — the one thing this response says that the password ones do not.
      // The client needs it to know whether to show the welcome flow, and it is
      // a REPORT of what the server decided, not an echo of what was asked.
      isNewUser: outcome.isNewUser,
    });
  }

  // POST /auth/oauth/apple
  router.post("/auth/oauth/apple", authLimiter, async (req, res) => {
    const parsed = appleOAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { identityToken, rawNonce, authorizationCode, ...body } = parsed.data;

    // The OFF state, before anything else: no audience configured means the
    // deploy has not been wired to Apple, and saying 503 is honest where a 401
    // would blame the caller for the operator's missing variable.
    if (oauthConfig.appleAudiences.length === 0) {
      return res.status(503).json({ code: "oauth_unavailable" });
    }
    if (body.marketingConsentSms && !body.phone) {
      return res.status(400).json({ error: "SMS consent requires a phone number" });
    }

    try {
      const verdict = await verifyApple({
        identityToken,
        rawNonce,
        audiences: oauthConfig.appleAudiences,
      });

      // ── Part E · the code exchange, AFTER verification and never before ──
      //
      // ORDERING MATTERS: the code is only exchanged once the identity token
      // has proved itself, so an unverified caller cannot make this server
      // spend an outbound round trip on Apple for them.
      //
      // 🔴 EVERY FAILURE HERE IS SILENT TO THE CALLER. A missing code, a
      // deploy with no signing trio, no encryption key, an Apple timeout, an
      // unencryptable token — all of them leave `appleRefreshTokenEnc` null
      // and let the sign-in proceed. The person is verified; refusing to let
      // them in because a secondary call to Apple failed would trade a real
      // login for a future convenience. The cost is recorded in the log and
      // in the boot line, and lands on DELETE /me, which will have nothing to
      // revoke for this identity and says so.
      let appleRefreshTokenEnc: string | null = null;
      if (verdict.ok && authorizationCode && oauthConfig.appleSigning && oauthConfig.appleRefreshEncSecret) {
        const exchange = await exchangeAppleCode({
          signing: oauthConfig.appleSigning,
          // The client id the token was ACTUALLY minted for — not a constant.
          // Apple's /auth/revoke insists on the same one later, which is why
          // it is recorded on the identity row beside the token.
          clientId: verdict.identity.audience,
          authorizationCode,
          // Row 9 (1.1) · Stripe S1 Part F — D-WS9-268 follow-up. The exchange
          // decides on its own whether to send a redirect_uri, by comparing the
          // VERIFIED audience above to the configured Services ID. Both env vars
          // unset => appleWebRedirect is null => exactly today behaviour.
          webRedirect: oauthConfig.appleWebRedirect,
          fetchImpl: productionAppleFetch,
        });
        if (exchange.refreshToken) {
          try {
            appleRefreshTokenEnc = encryptSecret(
              exchange.refreshToken,
              oauthConfig.appleRefreshEncSecret,
            );
          } catch (err) {
            // Storing it in the clear instead is NOT the fallback. A live
            // bearer credential against appleid.apple.com does not go into a
            // column unencrypted because the encryption failed.
            logger.error(
              { event: "apple_refresh_token_unencryptable", err },
              "Could not encrypt Apple's refresh token — NOT stored; DELETE /me will have nothing to revoke",
            );
          }
        }
      }

      return await completeOAuthSignIn({
        provider: "apple",
        verdict,
        body,
        appleRefreshTokenEnc,
        res,
      });
    } catch (err) {
      if (err instanceof GuestSessionInvalidError) {
        logger.info(
          { event: "guest_claim_refused", provider: "apple", detail: err.detail },
          "Apple sign-up refused: the guest session could not be claimed",
        );
        return res.status(409).json({ code: "guest_session_invalid" });
      }
      logger.error({ err }, "Apple OAuth failed");
      return res.status(500).json({ error: "sign-in failed" });
    }
  });

  // POST /auth/oauth/google
  router.post("/auth/oauth/google", authLimiter, async (req, res) => {
    const parsed = googleOAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { idToken, ...body } = parsed.data;

    if (oauthConfig.googleClientIds.length === 0) {
      return res.status(503).json({ code: "oauth_unavailable" });
    }
    if (body.marketingConsentSms && !body.phone) {
      return res.status(400).json({ error: "SMS consent requires a phone number" });
    }

    try {
      const verdict = await verifyGoogle({ idToken, clientIds: oauthConfig.googleClientIds });
      return await completeOAuthSignIn({ provider: "google", verdict, body, res });
    } catch (err) {
      if (err instanceof GuestSessionInvalidError) {
        logger.info(
          { event: "guest_claim_refused", provider: "google", detail: err.detail },
          "Google sign-up refused: the guest session could not be claimed",
        );
        return res.status(409).json({ code: "guest_session_invalid" });
      }
      logger.error({ err }, "Google OAuth failed");
      return res.status(500).json({ error: "sign-in failed" });
    }
  });

  // POST /auth/logout
  // Client-side logout — server just acknowledges.
  // TODO(future): add jti blocklist for real server-side revocation.
  router.post("/auth/logout", async (_req, res) => {
    return res.json({ success: true });
  });

  // POST /auth/password-reset/request
  // Always returns success to prevent email enumeration.
  // Reset tokens carry purpose='password_reset' and expire after 1h (WS7-2
  // Block A — tighter than the 30d session default).
  // D-WS7-022 (deferred): real email delivery infra lands in WS9A polish.
  router.post("/auth/password-reset/request", resetLimiter, async (req, res) => {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const normalizedEmail = parsed.data.email.toLowerCase().trim();

    try {
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (user) {
        const resetToken = signToken(user.id, {
          purpose: "password_reset",
          expiresIn: PASSWORD_RESET_EXPIRY,
        });
        // BUG-219 — the live token and its `kiwi://reset-password?token=…`
        // deep link used to be logged here at `info`. Nothing about the code
        // was wrong on a laptop, where that is a scrollback buffer. On Cloud
        // Run the same line lands in Cloud Logging: durable, indexed, retained,
        // and readable by anyone holding `roles/logging.viewer` on the project.
        // A live account-takeover credential does not go in a log sink, and
        // `logger.info` fires regardless of NODE_ENV.
        //
        // BUG-224 — this is that call site. With no RESEND_API_KEY the sender
        // returns a typed no-op and the response below is unchanged, so the
        // behaviour with no key is identical to what shipped in `fa1859c`.
        //
        // The result is deliberately NOT surfaced to the caller: this route
        // answers `{ success: true }` unconditionally for anti-enumeration
        // (§1.10), and leaking "we did/didn't send" would reintroduce exactly
        // the oracle that design removes.
        const link = buildAppLink("/reset-password", resetToken);
        const result = await sendEmail(passwordResetMessage(normalizedEmail, link));
        logger.info(
          {
            event: "password_reset_requested",
            userId: user.id,
            sent: result.sent,
            ...(result.sent ? {} : { reason: result.reason }),
          },
          "Password reset requested",
        );
      }
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Password reset request failed");
      // Still return success to avoid enumeration via timing/status differences.
      return res.json({ success: true });
    }
  });

  // POST /auth/password-reset/confirm
  router.post("/auth/password-reset/confirm", authLimiter, async (req, res) => {
    const parsed = resetConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { token, newPassword } = parsed.data;

    const payload = verifyToken(token, "password_reset");
    if (!payload) {
      return res.status(400).json({ error: "invalid or expired reset token" });
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user || user.accountStatus !== "active") {
        return res.status(400).json({ error: "invalid or expired reset token" });
      }

      // BUG-233, second clause — a reset link issued before the last password
      // change is stale even though its signature and expiry are both fine.
      // This is what makes "a completed reset invalidates every OTHER
      // outstanding reset token" true: the older link verifies, gets here, and
      // is refused because it predates the epoch the completed reset set.
      if (isIssuedBeforeEpoch(payload.iat, user.tokensValidFrom)) {
        logger.warn(
          { userId: user.id, reason: "before_epoch" },
          "Password reset token refused",
        );
        return res.status(400).json({ error: "invalid or expired reset token" });
      }

      // BUG-233 — spend the token BEFORE changing anything. This is the write
      // that makes the link single-use, and it is atomic: two concurrent
      // redemptions of one token race on the UsedToken primary key and exactly
      // one wins. Doing it first means a loser never reaches the password
      // write, so a double-submit cannot produce two resets.
      const redeemed = await redeemPurposeToken(prisma, payload, "password_reset");
      if (!redeemed.ok) {
        logger.warn(
          { userId: payload.userId, reason: redeemed.reason },
          "Password reset token refused",
        );
        // Same opaque 400 as a bad signature. A distinct "already used" reply
        // would tell an attacker holding a stolen link that it WAS valid and
        // that someone beat them to it, which is an oracle worth denying.
        return res.status(400).json({ error: "invalid or expired reset token" });
      }

      const passwordHash = await hashPassword(newPassword);
      const resetAt = new Date();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // BUG-234 — the point of a reset, for a compromised account, is to
          // evict the other person; before this the attacker's 30-day session
          // JWT simply carried on. Bumping the epoch here does that, and in the
          // same statement as the password write so the two cannot diverge.
          //
          // BUG-233's other clause rides along: every OTHER outstanding reset
          // link for this user was issued before `resetAt` and dies with it.
          // Those tokens are stateless and un-enumerable, so an epoch is the
          // only mechanism that can reach them at all.
          tokensValidFrom: resetAt,
        },
      });

      // The caller is NOT signed in by this route — it answers { success: true }
      // and nothing else, exactly as it did at c38a596 — so there is no fresh
      // session to preserve and no client change needed. The user logs in with
      // the new password, which is also the only outcome that proves the reset
      // took. Minting a session here would be a client-visible contract change
      // and is out of this block's scope.
      logger.info({ userId: user.id }, "Password reset completed");
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Password reset confirm failed");
      return res.status(500).json({ error: "password reset failed" });
    }
  });

  // GET /auth/me
  router.get("/auth/me", requireAuth, meLimiter, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        include: { subscription: true },
      });
      if (!user) {
        // Token valid but user deleted — client should treat as logout.
        return res.status(401).json({ error: "user not found" });
      }
      return res.json({
        user: {
          ...toUserShape(user),
          subscription: user.subscription
            ? toSubscriptionShape(user.subscription)
            : null,
        },
      });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "Fetch /auth/me failed");
      return res.status(500).json({ error: "failed to fetch user" });
    }
  });

  return router;
}

// Default export — uses the production Prisma singleton, mounted by routes/index.ts.
const router: IRouter = createAuthRouter();
export default router;
