// Row 9 (1.1) · Stripe S2 Part D — THE ONE HOLDER OF BILLING STATE.
//
// Everything billing that is not a pure decision lives here: the subscription
// query, the sheet's visibility, the two per-device sets, the foreground refetch,
// the 402 subscription, and the two link-outs. Every DECISION it makes is a call
// into lib/billing/* — this file is wiring, and it is deliberately the only wiring.
//
// 🔴 WHY ONE CONTEXT RATHER THAN A HOOK PER SCREEN. Four surfaces need the same
// answer at the same time (the Home banner, the Settings row, the notices, the
// sheet), and three things must happen exactly once per app rather than once per
// consumer: the AppState listener, the 402 subscription, and the device-flag
// reads. A hook would give each screen its own copy of all three — three
// listeners, three sheets racing, and an upsell moment that fires once per mounted
// consumer instead of once per device.
//
// ⚠️ EVERY REF IS SYNCED IN AN EFFECT, NEVER DURING RENDER. babel-plugin-react-
// compiler is on for this package, and a render-phase `ref.current = x` is not a
// style question under it — the compiler may memoize the render that contained the
// write, and the write silently stops happening (the Row 9 OAuth Block 2 lane hit
// exactly this). The refs exist so the AppState listener and the 402 subscription
// can be registered ONCE and still read fresh state; a listener re-registered on
// every subscription change would drop an event that arrived between its
// unsubscribe and its resubscribe.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
//
// It never decides whether a surface is visible. `enforced === false` is checked
// inside lib/billing/subscriptionView.ts, not here, so the blackout cannot be
// lost by a provider refactor — and the test that proves it needs no React tree.
//
// It does not fetch for a guest or a signed-out visitor. A Test Kitchen visitor
// has no member and no billing state (§2.10), and `GET /me/subscription` requires
// auth, so asking would produce a 401 and a session cascade on a screen the
// visitor reached without ever signing in.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Linking, Platform, type AppStateStatus } from "react-native";

import { subscribeUpgradeEvents } from "@/lib/api/upgrade-bridge";
import {
  POLL_INTERVAL_MS,
  awaitingPhase,
  shouldPoll,
  type AwaitingPhase,
} from "@/lib/billing/awaitingCheckout";
import {
  SUBSCRIPTION_QUERY_KEY,
  billingRail,
  createCheckoutSession,
  createPortalSession,
  fetchSubscription,
  openBillingUrl,
  syncStoreSubscription,
  type BillingPlan,
  type SubscribedElsewhere,
} from "@/lib/billing/api";
import {
  CHECKOUT_ALREADY,
  CHECKOUT_FAILED,
  CHECKOUT_UNAVAILABLE,
  MANAGE_OPEN_FAILED,
  PORTAL_NO_ACCOUNT,
  SHEET_PURCHASE_FAILED,
  SHEET_PURCHASE_PENDING,
  SHEET_RESTORE_FAILED,
  SHEET_RESTORE_NONE,
  subscribedInStore,
} from "@/lib/billing/copy";
import { dismissBanner, loadDismissedBanners } from "@/lib/billing/dismissals";
import {
  loadStoreOffer,
  purchaseStorePackage,
  restoreStorePurchases,
  storeKey,
  syncStoreIdentity,
  type StoreOfferView,
} from "@/lib/billing/store";
import { confirmStorePurchase } from "@/lib/billing/storeConfirm";
import {
  bannerFor,
  isPayingStatus,
  manageActionFor,
  sheetStateFor,
  storeBillingReady,
  type BannerKind,
  type BannerView,
  type SheetState,
  type SubscriptionPayload,
} from "@/lib/billing/subscriptionView";
import {
  loadSeenMoments,
  markMomentSeen,
  shouldFireUpsellMoment,
  type UpsellMoment,
} from "@/lib/billing/upsellMoments";
import { useAuth } from "@/contexts/AuthContext";

export interface BillingContextValue {
  /** The last `GET /me/subscription`, or null while none has landed. */
  subscription: SubscriptionPayload | null;
  /** Which banner Home should show, already gated on `enforced` and dismissals. */
  banner: BannerView | null;
  dismissCurrentBanner: () => void;
  /** The sheet's state, or null when it is closed. */
  sheet: SheetState | null;
  openSheet: (state?: SheetState) => void;
  closeSheet: () => void;
  /** "Finishing up…" / "I've paid — check again" / neither. */
  awaiting: AwaitingPhase;
  /** A price button. Resolves when the link-out has been handed off or refused. */
  startCheckout: (plan: BillingPlan) => Promise<void>;
  /** "Manage payment" / "Manage subscription". */
  openPortal: () => Promise<void>;
  /** Non-null while a link-out failed in a way the user must be told about. */
  linkError: string | null;
  clearLinkError: () => void;
  checkoutBusy: boolean;
  /** Refetch now. Used by the return pages and "I've paid — check again". */
  refetch: () => void;
  /**
   * An upsell moment reached its trigger. Fires the sheet if all four gates pass
   * and records the moment; a no-op otherwise. NEVER blocks and never throws.
   */
  fireUpsellMoment: (moment: UpsellMoment) => void;

  // ── Resub C2 · the store rail (iOS / Android) ──────────────────────────
  /** The current offering's packages, once loaded for an open sheet. */
  storeOffer: StoreOfferView | null;
  /** "unavailable" = no key, no RevenueCat on the server, or no offering: no buy buttons. */
  storeOfferStatus: StoreOfferStatus;
  /** What the store side of the sheet is doing. Buy buttons show only at "idle". */
  storePhase: StorePhase;
  /** A line for the sheet after a failed purchase / restore. Never for a cancel. */
  storeMessage: string | null;
  restorePurchases: () => Promise<void>;
  /** "Check again" after a confirmation stalled — another store-sync, never a purchase. */
  checkStoreAgain: () => Promise<void>;
  /** Open a store subscription page (managementUrl / the store's own page). */
  openManagement: (url: string) => void;
  /** Web: the last 409 `subscribed_elsewhere`, for its "manage it there" link. */
  elsewhere: SubscribedElsewhere | null;
}

export type StoreOfferStatus = "idle" | "loading" | "ready" | "unavailable";
export type StorePhase = "idle" | "purchasing" | "restoring" | "confirming" | "stalled";

const BillingContext = createContext<BillingContextValue | null>(null);

export function BillingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<BannerKind>>(new Set());
  const [seenMoments, setSeenMoments] = useState<ReadonlySet<UpsellMoment>>(new Set());
  const [launchedAt, setLaunchedAt] = useState<number | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Re-renders the awaiting phase on a timer without re-fetching: the phase is a
  // function of `now`, so something has to tick for "polling" to become "stalled".
  const [tick, setTick] = useState(0);

  // ── the refs, declared together and written only in the sync effect ─────
  const subscriptionRef = useRef<SubscriptionPayload | null>(null);
  const refetchRef = useRef<() => void>(() => {});
  const seenMomentsRef = useRef<ReadonlySet<UpsellMoment>>(seenMoments);
  const dismissedRef = useRef<ReadonlySet<BannerKind>>(dismissed);
  const bannerRef = useRef<BannerView | null>(null);
  // Not state-derived: a guard against two taps landing in the same tick, each of
  // which can create a Stripe customer. State would give both closures `false`.
  const checkoutBusyRef = useRef(false);

  // ── Resub C2 · the store rail ──────────────────────────────────────────
  const rail = billingRail(Platform.OS);
  const userId = user?.id ?? null;
  const [storeOffer, setStoreOffer] = useState<StoreOfferView | null>(null);
  const [storeOfferStatus, setStoreOfferStatus] = useState<StoreOfferStatus>("idle");
  const [storePhase, setStorePhase] = useState<StorePhase>("idle");
  const [storeMessage, setStoreMessage] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<SubscribedElsewhere | null>(null);
  // 🔴 THE ONE-PURCHASE LOCK, as a ref for the same reason as checkoutBusyRef:
  // two taps in one tick must not both reach the store. Held from the tap until
  // the purchase is CONFIRMED — through every store-sync retry — and while a
  // confirmation is stalled, because the money is already taken then.
  const storeLockRef = useRef(false);
  const storeOfferRef = useRef<StoreOfferView | null>(null);
  const userIdRef = useRef<string | null>(userId);
  /** Whether the stalled confirmation was a purchase (must read as paying) or a restore. */
  const pendingConfirmRef = useRef<{ expectPaying: boolean } | null>(null);

  // RevenueCat's customer follows the Kiwi user: configure at the first signed-in
  // user, logIn on every later one, logOut on sign-out. See lib/billing/store.ts.
  useEffect(() => {
    if (rail !== "store") return;
    void syncStoreIdentity(userId);
  }, [rail, userId]);

  // ── the query ──────────────────────────────────────────────────────────
  const enabled = !!user;
  const query = useQuery({
    queryKey: SUBSCRIPTION_QUERY_KEY,
    queryFn: fetchSubscription,
    enabled,
    // `personal` tier. The refetches that matter are explicit (foreground, sheet
    // dismissal, the return pages), so this only stops two consumers mounting at
    // once from making two requests.
    staleTime: 60_000,
  });
  const subscription = query.data ?? null;

  const refetch = useCallback(() => {
    if (!enabled) return;
    void queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_QUERY_KEY });
  }, [enabled, queryClient]);

  // ── the banner ─────────────────────────────────────────────────────────
  const banner = useMemo(
    () => bannerFor({ sub: subscription, now: new Date(), dismissed }),
    [subscription, dismissed],
  );

  // 🔴 THE SYNC EFFECT. No dependency array on purpose: it runs after every
  // commit, which is what makes the refs current for anything that fires later
  // (a timer, a listener, a tap). At worst a 402 landing between a render and
  // this effect reads one-render-old state, and the refetch it triggers corrects
  // that on the next commit.
  useEffect(() => {
    subscriptionRef.current = subscription;
    refetchRef.current = refetch;
    seenMomentsRef.current = seenMoments;
    dismissedRef.current = dismissed;
    bannerRef.current = banner;
    storeOfferRef.current = storeOffer;
    userIdRef.current = userId;
  });

  // ── the per-device sets, read once ─────────────────────────────────────
  //
  // Both start EMPTY rather than full, and the asymmetry with the personalize
  // nudge (which starts `true` so a must-tap modal cannot flash) is deliberate:
  // these gate a dismissible banner and a dismissible sheet, so a moment of
  // showing before the read lands costs a tap, not a decision. See
  // upsellMoments.ts's note.
  useEffect(() => {
    let cancelled = false;
    void loadDismissedBanners().then((s) => {
      if (!cancelled) setDismissed(s);
    });
    void loadSeenMoments().then((s) => {
      if (!cancelled) setSeenMoments(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── the 402 subscription (§2.7) ────────────────────────────────────────
  useEffect(() => {
    return subscribeUpgradeEvents((event) => {
      const sub = subscriptionRef.current;
      // `ignoreEnforcement` — the server refused, so its authority outranks our
      // possibly-stale copy of the flag. See sheetStateFor's note.
      const state = sheetStateFor(sub, { ignoreEnforcement: true });
      if (state === null) return;
      if (sub !== null && sub.enforced === false) {
        // §2.7: "if one arrives anyway, log it and show the sheet." A 402 under an
        // unenforced deploy means our config read is stale or a gate shipped ahead
        // of the flag — either way it is worth a line.
        console.warn(
          "[billing] a 402 arrived while enforcement was believed OFF",
          event.path,
        );
      }
      setSheet(state);
      // The refusal is itself evidence our snapshot is stale.
      refetchRef.current();
    });
  }, []);

  // ── the foreground refetch (§2.3) ──────────────────────────────────────
  //
  // EVERY foreground, not only after a checkout. The user pays in the system
  // browser and comes back by hand, so "the app became active" is the only signal
  // the app gets that anything may have changed — and on web the same listener
  // fires on tab focus, which is the return-from-Stripe case there.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") refetchRef.current();
    });
    return () => sub.remove();
  }, []);

  // ── the bounded poll after a checkout (§2.3) ───────────────────────────
  const status = subscription?.status ?? null;
  const awaitingInput = useMemo(
    () => ({ launchedAt, now: Date.now(), status }),
    // `tick` is what makes this recompute; Date.now() is not reactive on its own.
    [launchedAt, status, tick],
  );
  const awaiting = awaitingPhase(awaitingInput);

  useEffect(() => {
    if (!shouldPoll(awaitingInput)) return;
    const t = setTimeout(() => {
      refetchRef.current();
      setTick((n) => n + 1);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [awaitingInput]);

  // Once the webhook has landed there is nothing to wait for, and the window must
  // be CLEARED rather than left to expire — a later resubscribe in the same
  // session needs its own window, not an inherited expired one.
  useEffect(() => {
    if (status === "active" || status === "past_due") {
      setLaunchedAt(null);
      setCheckoutBusy(false);
    }
  }, [status]);

  // ── the sheet ──────────────────────────────────────────────────────────
  const openSheet = useCallback((state?: SheetState) => {
    const resolved = state ?? sheetStateFor(subscriptionRef.current);
    if (resolved === null) return;
    setSheet(resolved);
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(null);
    // A message belongs to the sheet it was shown on. A confirmation in flight
    // keeps running behind a closed sheet and lands in the query either way.
    setStoreMessage(null);
    // §2.3 — refetch when the sheet is dismissed. The user may have paid in the
    // browser and come back to a sheet still showing the paywall.
    refetchRef.current();
  }, []);

  // ── Resub C2 · the offering, loaded when the sheet opens on the store rail ──
  const storeReady = storeBillingReady({
    platform: Platform.OS,
    keyPresent: storeKey() !== null,
    sub: subscription,
  });
  const sheetOpen = sheet !== null;
  useEffect(() => {
    if (rail !== "store" || !sheetOpen) return;
    if (!storeReady || userId === null) {
      // No key on this build, no RevenueCat on the server, or nobody signed in:
      // the sheet says purchases are unavailable and shows no buy button.
      setStoreOfferStatus("unavailable");
      return;
    }
    let cancelled = false;
    setStoreOfferStatus("loading");
    void (async () => {
      await syncStoreIdentity(userId);
      const offer = await loadStoreOffer();
      if (cancelled) return;
      setStoreOffer(offer);
      setStoreOfferStatus(offer ? "ready" : "unavailable");
    })();
    return () => {
      cancelled = true;
    };
  }, [rail, sheetOpen, storeReady, userId]);

  // ── the purchase, by rail ──────────────────────────────────────────────

  /** A web 409 `subscribed_elsewhere`: say where it is managed, offer the link. */
  const showElsewhere = useCallback((e: SubscribedElsewhere) => {
    setElsewhere({ source: e.source, managementUrl: e.managementUrl });
    setLinkError(subscribedInStore(e.source));
    refetchRef.current();
  }, []);

  /**
   * Store rail: hear from Kiwi that the store took the money (POST
   * /billing/store-sync, retried with backoff — lib/billing/storeConfirm.ts).
   * The one-purchase lock stays held until this confirms, and through a stall.
   */
  const confirmWithKiwi = useCallback(
    async (expectPaying: boolean) => {
      pendingConfirmRef.current = { expectPaying };
      setStorePhase("confirming");
      const outcome = await confirmStorePurchase({ sync: syncStoreSubscription, expectPaying });
      if (outcome.kind === "stalled" || outcome.kind === "unavailable") {
        // The money may be taken; Kiwi has not heard. "Check again", never "buy".
        setStorePhase("stalled");
        return;
      }
      pendingConfirmRef.current = null;
      storeLockRef.current = false;
      setStorePhase("idle");
      if (outcome.kind === "unauthenticated") return;
      // Refresh billing state from the answer itself — no second round trip.
      queryClient.setQueryData(SUBSCRIPTION_QUERY_KEY, outcome.subscription);
      if (isPayingStatus(outcome.subscription.status)) {
        setSheet(null);
      } else {
        setStoreMessage(SHEET_RESTORE_NONE);
      }
    },
    [queryClient],
  );

  const startStorePurchase = useCallback(
    async (plan: BillingPlan) => {
      if (storeLockRef.current) return;
      const pkg = storeOfferRef.current?.[plan] ?? null;
      const uid = userIdRef.current;
      if (pkg === null || uid === null) return;
      storeLockRef.current = true;
      setStorePhase("purchasing");
      setStoreMessage(null);
      const outcome = await purchaseStorePackage(pkg.pkg, uid);
      if (outcome.kind !== "purchased") {
        storeLockRef.current = false;
        setStorePhase("idle");
        // A cancel is the person changing their mind: say nothing at all.
        if (outcome.kind === "pending") setStoreMessage(SHEET_PURCHASE_PENDING);
        if (outcome.kind === "failed") setStoreMessage(SHEET_PURCHASE_FAILED);
        return;
      }
      await confirmWithKiwi(true);
    },
    [confirmWithKiwi],
  );

  const restorePurchases = useCallback(async () => {
    if (rail !== "store" || storeLockRef.current) return;
    const uid = userIdRef.current;
    if (uid === null) return;
    storeLockRef.current = true;
    setStorePhase("restoring");
    setStoreMessage(null);
    const outcome = await restoreStorePurchases(uid);
    if (outcome.kind === "failed") {
      storeLockRef.current = false;
      setStorePhase("idle");
      setStoreMessage(SHEET_RESTORE_FAILED);
      return;
    }
    // The store's answer is not the account's: Kiwi re-reads RevenueCat and
    // says what is actually unlocked.
    await confirmWithKiwi(false);
  }, [rail, confirmWithKiwi]);

  const checkStoreAgain = useCallback(async () => {
    const pending = pendingConfirmRef.current;
    if (pending === null) return;
    await confirmWithKiwi(pending.expectPaying);
  }, [confirmWithKiwi]);

  const openManagement = useCallback((url: string) => {
    setLinkError(null);
    Linking.openURL(url).catch(() => setLinkError(MANAGE_OPEN_FAILED));
  }, []);

  const startCheckout = useCallback(
    async (plan: BillingPlan) => {
      // 🔴 RESUB C2 — THE RAIL BRANCH. iOS and Android sell through the store and
      // never reach a Stripe route or a Stripe URL (3.1.1).
      if (rail === "store") {
        await startStorePurchase(plan);
        return;
      }
      if (checkoutBusyRef.current) return;
      checkoutBusyRef.current = true;
      setCheckoutBusy(true);
      setLinkError(null);
      setElsewhere(null);
      try {
        const res = await createCheckoutSession(plan);
        if (!res.success) {
          if (res.error === "already_subscribed") {
            // Not an error the user caused — a stale paywall, or a second device.
            setLinkError(CHECKOUT_ALREADY);
            setSheet(null);
            refetchRef.current();
          } else if (res.error === "subscribed_elsewhere") {
            // Paying through the App Store / Google Play: never sell a second one.
            showElsewhere(res);
          } else if (res.error === "billing_unavailable") {
            setLinkError(CHECKOUT_UNAVAILABLE);
          } else if (res.error !== "unauthenticated") {
            // A 401 already fired the session cascade; the sign-in screen says it
            // better than a line on a sheet that is about to unmount.
            setLinkError(CHECKOUT_FAILED);
          }
          return;
        }
        // 🔴 STAMP BEFORE OPENING. On web `openBillingUrl` navigates away, and any
        // state set after that call is set on a page that is already leaving.
        setLaunchedAt(Date.now());
        const opened = await openBillingUrl(res.url);
        if (!opened) {
          // Nothing was launched, so nothing is pending.
          setLaunchedAt(null);
          setLinkError(CHECKOUT_FAILED);
        }
      } catch {
        // createCheckoutSession does not throw for HTTP errors (envelope mode), so
        // this is a programmer error or a torn-down module. The user still needs the
        // button to stop spinning.
        setLinkError(CHECKOUT_FAILED);
      } finally {
        checkoutBusyRef.current = false;
        setCheckoutBusy(false);
      }
    },
    [rail, startStorePurchase, showElsewhere],
  );

  const openPortal = useCallback(async () => {
    setLinkError(null);
    if (rail === "store") {
      // Resub C2 §3: a store subscription opens the store; a Stripe one is a
      // sentence with no link; no source opens nothing. Never the Portal.
      const action = manageActionFor(Platform.OS, subscriptionRef.current);
      if (action?.kind === "store_link") openManagement(action.url);
      return;
    }
    setElsewhere(null);
    const res = await createPortalSession();
    if (!res.success) {
      if (res.error === "no_billing_account") {
        // The inference behind the button was wrong, or the customer was created
        // after this client's last read. Say the true thing, and refetch so the
        // button corrects itself.
        setLinkError(PORTAL_NO_ACCOUNT);
        refetchRef.current();
      } else if (res.error === "subscribed_elsewhere") {
        showElsewhere(res);
      } else if (res.error === "billing_unavailable") {
        setLinkError(CHECKOUT_UNAVAILABLE);
      } else if (res.error !== "unauthenticated") {
        setLinkError(CHECKOUT_FAILED);
      }
      return;
    }
    const opened = await openBillingUrl(res.url);
    if (!opened) setLinkError(CHECKOUT_FAILED);
  }, [rail, openManagement, showElsewhere]);

  // ── the upsell moments (§2.5) ──────────────────────────────────────────
  const fireUpsellMoment = useCallback((moment: UpsellMoment) => {
    // The gate is pure and lives in lib/. NEVER BLOCKING: this returns
    // immediately, the caller has already completed its action, and the persist
    // happens behind the sheet.
    if (
      !shouldFireUpsellMoment({
        moment,
        sub: subscriptionRef.current,
        seen: seenMomentsRef.current,
      })
    ) {
      return;
    }
    // In-memory FIRST, so a second trigger inside the same session cannot race
    // the storage write. This is an event handler, not a render, so writing the
    // ref here is safe.
    const optimistic = new Set(seenMomentsRef.current);
    optimistic.add(moment);
    seenMomentsRef.current = optimistic;
    setSeenMoments(optimistic);
    setSheet("trialing");
    void markMomentSeen(moment, optimistic).then(setSeenMoments);
  }, []);

  const dismissCurrentBanner = useCallback(() => {
    const kind = bannerRef.current?.kind;
    if (!kind) return;
    // Optimistic, so the banner leaves on the tap rather than on the write.
    const optimistic = new Set(dismissedRef.current);
    optimistic.add(kind);
    dismissedRef.current = optimistic;
    setDismissed(optimistic);
    // dismissBanner is a no-op for a non-dismissible kind, so `past_due` cannot
    // be written even if a caller reached here with it.
    void dismissBanner(kind, optimistic).then(setDismissed);
  }, []);

  const clearLinkError = useCallback(() => setLinkError(null), []);

  const value = useMemo<BillingContextValue>(
    () => ({
      subscription,
      banner,
      dismissCurrentBanner,
      sheet,
      openSheet,
      closeSheet,
      awaiting,
      startCheckout,
      openPortal,
      linkError,
      clearLinkError,
      checkoutBusy,
      refetch,
      fireUpsellMoment,
      storeOffer,
      storeOfferStatus,
      storePhase,
      storeMessage,
      restorePurchases,
      checkStoreAgain,
      openManagement,
      elsewhere,
    }),
    [
      subscription,
      banner,
      dismissCurrentBanner,
      sheet,
      openSheet,
      closeSheet,
      awaiting,
      startCheckout,
      openPortal,
      linkError,
      clearLinkError,
      checkoutBusy,
      refetch,
      fireUpsellMoment,
      storeOffer,
      storeOfferStatus,
      storePhase,
      storeMessage,
      restorePurchases,
      checkStoreAgain,
      openManagement,
      elsewhere,
    ],
  );

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

/**
 * Billing state, or a safe inert value outside the provider.
 *
 * NOT a throwing `useContext` assertion, deliberately. The Test Kitchen routes
 * render outside this provider by design (§2.10 — a guest has no member and no
 * billing state), and a component shared between a guest screen and a member one
 * must not crash on the guest side. Every field is the "nothing to show" value.
 */
export function useBilling(): BillingContextValue {
  const ctx = useContext(BillingContext);
  return ctx ?? INERT;
}

const NOOP_ASYNC = async () => {};
const INERT: BillingContextValue = {
  subscription: null,
  banner: null,
  dismissCurrentBanner: () => {},
  sheet: null,
  openSheet: () => {},
  closeSheet: () => {},
  awaiting: "idle",
  startCheckout: NOOP_ASYNC,
  openPortal: NOOP_ASYNC,
  linkError: null,
  clearLinkError: () => {},
  checkoutBusy: false,
  refetch: () => {},
  fireUpsellMoment: () => {},
  storeOffer: null,
  storeOfferStatus: "idle",
  storePhase: "idle",
  storeMessage: null,
  restorePurchases: NOOP_ASYNC,
  checkStoreAgain: NOOP_ASYNC,
  openManagement: () => {},
  elsewhere: null,
};
