// Row 9 (1.1) · OAuth Block 1 Part D — WHO IS THIS, AND DO THEY ALREADY
// HAVE AN ACCOUNT?
//
// The verifier (lib/oauth/verify.ts) has already decided the token is real.
// This decides what it MEANS. There are exactly three answers and they are
// tried in this order:
//
//   (a) `(provider, subject)` already exists → that user signs in. The `sub`
//       claim is stable across an email change at both providers, so this is
//       the only branch that is about IDENTITY; the other two are about first
//       contact.
//
//   (b) The token asserts a VERIFIED email matching an existing user
//       (case-insensitively) → LINK a new identity row to that user and sign
//       them in. This is the branch that stops a person who signed up with a
//       password from getting a second, empty account the first time they tap
//       "Continue with Google".
//
//   (c) Otherwise → create the account.
//
// 🔴 WHY (b) REQUIRES `emailVerified`, spelled out because the check looks
// removable and is the whole security of this file:
//
//   An UNVERIFIED email assertion is a claim that someone typed an address,
//   not evidence they control it. If (b) accepted one, anybody able to make a
//   provider account asserting `hans@example.com` would be handed Hans's Kiwi
//   account — every plan, every preference — on a first sign-in. That is
//   account takeover through the front door.
//
// And the mirror of it, which is why an unverified email is REFUSED rather
// than sent down branch (c) to make a new account:
//
//   `users.email` is unique and is what password reset delivers to. An
//   account created from an unverified assertion of a REAL person's address
//   sits on that address; when the real owner later signs in with the same
//   (genuinely verified) address, branch (b) links them INTO the squatter's
//   account. Creating is not the safe fallback here — refusing is.
//
// The refusal reaches the wire as the same generic 401 as every other
// verification failure (§2.8); only the log says which one it was.

import { Prisma, type PrismaClient } from "@prisma/client";

import { createAccountInTx } from "../authAccount";
import { claimGuestSessionInTx } from "../guestClaim";
import { logger } from "../logger";
import type { VerifiedIdentity } from "./verify";

export type ResolveRefusal = "email_unverified";

export interface IdentityLinkFacts {
  emailAtLink: string | null;
  emailVerified: boolean;
  isPrivateRelay: boolean;
  appleClientId: string | null;
  appleRefreshTokenEnc?: string | null;
}

export interface ResolveInput {
  prisma: PrismaClient;
  identity: VerifiedIdentity;
  /** Apple hands the name to the CLIENT once, on first authorisation only. */
  bodyFirstName?: string | undefined;
  bodyLastName?: string | undefined;
  zipCode?: string | undefined;
  timezone?: string | undefined;
  phone?: string | null | undefined;
  marketingConsentEmail?: boolean | undefined;
  marketingConsentSms?: boolean | undefined;
  platform?: string | undefined;
  guestSessionId?: string | undefined;
  /** Written only on create; an existing identity's row is refreshed instead. */
  linkFacts: IdentityLinkFacts;
}

export type ResolveOutcome =
  | { ok: false; reason: ResolveRefusal }
  | {
      ok: true;
      userId: string;
      isNewUser: boolean;
      /** Non-null only for a NEW account — stage 2 of the claim runs on it. */
      claimedDraft: unknown;
      /** Did this call create the identity row (vs. find it)? For the log. */
      identityCreated: boolean;
      identityId: string;
    };

const IDENTITY_FACT_SELECT = { id: true, userId: true } as const;

/**
 * A name is never overwritten on an existing account. The body's name is
 * offered at CREATE time only, and even then the provider's claims are a
 * fallback: a client that collected a name has something more current than a
 * Google profile the user last edited in 2014, and Apple's identity token
 * carries no name at all.
 *
 * Empty strings are the documented floor (§2.4c). A `User.firstName` is
 * non-null in the schema, and inventing "Apple" or "User" would put a fake
 * name in front of a real person on their own Home screen.
 */
function resolveNames(input: ResolveInput): { firstName: string; lastName: string } {
  const pick = (body: string | undefined, claim: string | null): string =>
    (body ?? "").trim() || (claim ?? "").trim() || "";
  return {
    firstName: pick(input.bodyFirstName, input.identity.firstName),
    lastName: pick(input.bodyLastName, input.identity.lastName),
  };
}

export async function resolveIdentity(input: ResolveInput): Promise<ResolveOutcome> {
  const { prisma, identity } = input;
  const provider = identity.provider;

  // ── (a) the identity we already know ──────────────────────────────────
  const existing = await prisma.userIdentity.findUnique({
    where: { provider_subject: { provider, subject: identity.subject } },
    select: IDENTITY_FACT_SELECT,
  });
  if (existing) {
    // The FACTS are refreshed (the email at the provider may have changed, a
    // fresh authorization code may carry a new refresh token) but the LINK is
    // not re-decided. `userId` is never touched: an identity does not migrate
    // between accounts, and a token that could move one would be a takeover.
    await prisma.userIdentity.update({
      where: { id: existing.id },
      data: {
        emailAtLink: input.linkFacts.emailAtLink,
        emailVerified: input.linkFacts.emailVerified,
        isPrivateRelay: input.linkFacts.isPrivateRelay,
        ...(input.linkFacts.appleClientId !== null
          ? { appleClientId: input.linkFacts.appleClientId }
          : {}),
        // Only when we actually got one. A failed code exchange must not blank
        // the refresh token a previous sign-in successfully stored.
        ...(input.linkFacts.appleRefreshTokenEnc
          ? { appleRefreshTokenEnc: input.linkFacts.appleRefreshTokenEnc }
          : {}),
      },
    });
    return {
      ok: true,
      userId: existing.userId,
      isNewUser: false,
      claimedDraft: null,
      identityCreated: false,
      identityId: existing.id,
    };
  }

  // ── (b) a verified email we already have an account for ───────────────
  const email = identity.email;
  if (email && !identity.emailVerified) {
    logger.warn(
      { event: "oauth_email_unverified", provider, subject: identity.subject },
      "OAuth token asserted an UNVERIFIED email — refused rather than linked or created",
    );
    return { ok: false, reason: "email_unverified" };
  }
  if (!email) {
    // No email and no known subject: there is nothing to put in `users.email`,
    // which is NOT NULL and unique. Synthesising one ("sub@apple.invalid")
    // would create an account nobody can ever receive a password reset for.
    logger.warn(
      { event: "oauth_no_email", provider, subject: identity.subject },
      "OAuth token carried no email and the subject is unknown — cannot create an account",
    );
    return { ok: false, reason: "email_unverified" };
  }

  const byEmail = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (byEmail) {
    const created = await prisma.userIdentity.create({
      data: {
        userId: byEmail.id,
        provider,
        subject: identity.subject,
        emailAtLink: input.linkFacts.emailAtLink,
        emailVerified: input.linkFacts.emailVerified,
        isPrivateRelay: input.linkFacts.isPrivateRelay,
        appleClientId: input.linkFacts.appleClientId,
        appleRefreshTokenEnc: input.linkFacts.appleRefreshTokenEnc ?? null,
      },
      select: { id: true },
    });
    logger.info(
      { event: "oauth_identity_linked", provider, userId: byEmail.id },
      "Linked a provider identity to the existing account with that verified email",
    );
    return {
      ok: true,
      userId: byEmail.id,
      isNewUser: false,
      // NOT a new account, so no preferences copy — the sign-IN claim runs at
      // the route, exactly as password login's does.
      claimedDraft: null,
      identityCreated: true,
      identityId: created.id,
    };
  }

  // ── (c) a new account ─────────────────────────────────────────────────
  const { firstName, lastName } = resolveNames(input);
  const result = await prisma.$transaction(async (tx) => {
    const account = await createAccountInTx({
      tx,
      email,
      // 🔴 NULL, and the column has been nullable since before this block. An
      // OAuth-only user has no password and needs none; if they later complete
      // a password reset they simply gain one, losing nothing (§2.9).
      passwordHash: null,
      firstName,
      lastName,
      zipCode: input.zipCode ?? null,
      timezone: input.timezone ?? null,
      phone: input.phone ?? null,
      marketingConsentEmail: input.marketingConsentEmail,
      marketingConsentSms: input.marketingConsentSms,
      // D-WS9-264 — identical rule to password signup: a guest claim is the
      // more specific fact and beats the client's `platform`.
      signupSource: input.guestSessionId ? "test_kitchen" : (input.platform ?? null),
      guestSessionId: input.guestSessionId,
    });
    const identityRow = await tx.userIdentity.create({
      data: {
        userId: account.user.id,
        provider,
        subject: identity.subject,
        emailAtLink: input.linkFacts.emailAtLink,
        emailVerified: input.linkFacts.emailVerified,
        isPrivateRelay: input.linkFacts.isPrivateRelay,
        appleClientId: input.linkFacts.appleClientId,
        appleRefreshTokenEnc: input.linkFacts.appleRefreshTokenEnc ?? null,
      },
      select: { id: true },
    });
    return { account, identityId: identityRow.id };
  });

  return {
    ok: true,
    userId: result.account.user.id,
    isNewUser: true,
    claimedDraft: result.account.claimedDraft,
    identityCreated: true,
    identityId: result.identityId,
  };
}

/** The sign-IN claim: the plan follows, the preferences do NOT (guestClaim's header). */
export async function claimForExistingUser(opts: {
  prisma: PrismaClient;
  guestSessionId: string;
  userId: string;
}): Promise<unknown> {
  const claim = await opts.prisma.$transaction((tx) =>
    claimGuestSessionInTx({
      tx,
      guestSessionId: opts.guestSessionId,
      userId: opts.userId,
      copyPreferences: false,
    }),
  );
  return claim.draft;
}

/**
 * The unique index on `(provider, subject)` is the race guard: two
 * simultaneous first sign-ins with the same token cannot both create a user.
 * This recognises the loser so the route can retry once and take branch (a).
 */
export function isIdentityRaceLoss(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
