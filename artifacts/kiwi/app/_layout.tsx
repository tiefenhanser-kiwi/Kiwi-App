import { useFonts } from "expo-font";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
  Fraunces_500Medium_Italic,
  Fraunces_600SemiBold,
  Fraunces_600SemiBold_Italic,
  Fraunces_700Bold,
  Fraunces_700Bold_Italic,
} from "@expo-google-fonts/fraunces";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { BootstrapFailedScreen } from "@/components/BootstrapFailedScreen";
import { DialogHost } from "@/components/DialogHost";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider } from "@/contexts/AppContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { BillingProvider } from "@/contexts/BillingContext";
import { PaywallSheet } from "@/components/PaywallSheet";
import { GuestProvider, useGuestStoreReady, useIsGuestSafe } from "@/contexts/GuestContext";
import { ToastProvider } from "@/contexts/ToastProvider";
import { Palette } from "@/constants/tokens";
import { sessionGateShouldEvict } from "@/lib/sessionBootstrap";

SplashScreen.preventAutoHideAsync();

// React Query defaults — see lib/api/README.md for the per-query staleTime
// tiers (auth = Infinity, catalog = 5 min, personal = 60 s, hot = 0). The
// default below applies to queries that don't override staleTime.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 60_000,
    },
  },
});

/**
 * WS9 BUG-239 — the route reaction to a session that died mid-use.
 *
 * The 401 cascade was already complete on the state side: apiClient fires
 * emitSessionExpired(), and AuthContext.s subscriber clears SecureStore and
 * removes the ["auth"] queries. What was missing was ROUTING. app/index.tsx
 * is the only auth gate in the app and it only evaluates at "/" — once the
 * user has been redirected into (tabs) it is unmounted and never re-runs, and
 * (tabs)/_layout.tsx has no guard of its own. So a dead token left every
 * authenticated screen mounted and rendering against user === null: blank
 * fields, and initialsFor("") giving the "?" avatar Hans saw.
 *
 * This is not only the password-change path. Session JWTs expire at 30 days,
 * so every user reaches this state eventually without doing anything unusual;
 * a password change is just the reliable way to trigger it on demand.
 */
function SessionGate() {
  const { user, bootstrapStatus } = useAuth();
  // Row 13 "Test Kitchen" · Block 2 — a live guest session suppresses eviction.
  // "/test-kitchen" is a top-level route, so segments[0] is "test-kitchen": not
  // undefined, not "(auth)". A visitor there has no token, so bootstrapStatus is
  // "ok" with user null — the exact shape this gate evicts.
  //
  // Block 2b (BUG-314): this read alone was NOT enough. It is false for the whole
  // cold-start window, so a first visit was evicted to sign-in while
  // POST /guest/session was still in flight. The path half of the answer is
  // `segments[0]`, which sessionGateShouldEvict now reads through
  // deriveGuestRouteStatus; both halves are passed below.
  const isGuest = useIsGuestSafe();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // D-WS9-241 B — the decision is a pure function in lib/sessionBootstrap.ts
    // (app/** is outside the test glob). It returns false while the bootstrap
    // is pending ("no user" not yet meaningful), while it has FAILED (token
    // kept, user null — the failure screen owns that state and must not be
    // evicted from under a deep link), when there is a user, and at "/" or
    // inside "(auth)" — see the function for why each.
    if (
      !sessionGateShouldEvict({
        bootstrapStatus,
        hasUser: !!user,
        group: segments[0],
        isGuest,
      })
    ) {
      return;
    }
    // WS9 BUG-239 follow-up — SIGN-IN, not welcome. welcome.tsx renders no
    // error text, so every message the teardown sets (an expired session, a
    // password change) landed on a screen that cannot show it. sign-in
    // renders auth.error and only clears it on submit.
    //
    // This is also now the ONLY navigator for a dead session. profile.tsx
    // used to replace() itself right after endSession(), which raced: the
    // replace ran before React had re-rendered AuthProvider, (auth)/_layout
    // still read isAuthenticated true, bounced to "/", and index.tsx sent the
    // still-non-null user back into (tabs). That is the "nothing happened"
    // Hans saw. Keying on the SAME user that (auth)/_layout guards on means
    // the two cannot disagree: when this fires, that guard is already false.
    router.replace("/(auth)/sign-in");
  }, [user, bootstrapStatus, segments, router, isGuest]);

  return null;
}

/**
 * D-WS9-241 B (BUG-258) — on a bootstrap FAILURE the failure screen renders
 * IN PLACE OF the navigator. That is what makes the coverage route-agnostic:
 * a cold start on "/", on "(tabs)", or on a deep link all see this, because
 * nothing underneath (index.tsx's Redirect, (auth)/_layout's Redirect,
 * SessionGate) is mounted to bounce it. The initial URL is held by the
 * navigation container above this layout — the same reason the fonts-gate
 * `return null` below does not lose deep links — so a successful "Try again"
 * mounts the navigator onto the route the user opened.
 */
function RootLayoutNav() {
  const { bootstrapStatus, retryBootstrap, abandonBootstrap } = useAuth();
  if (bootstrapStatus === "failed") {
    return (
      <BootstrapFailedScreen onRetry={retryBootstrap} onSignOut={abandonBootstrap} />
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Palette.background.app } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding-prefs" options={{ presentation: "modal" }} />
      <Stack.Screen name="onboarding-step-3" />
      <Stack.Screen name="wizard" options={{ presentation: "modal" }} />
      <Stack.Screen name="tellkiwi" options={{ presentation: "modal" }} />
      {/* D-WS9-191 — the chooser is /plan-options (Block 2); wizard-results
          and wizard-plan-details were deleted in Block 3 (D-WS9-032 point 7),
          once the device pass confirmed the new flow. */}
      <Stack.Screen name="plan-options" />
      <Stack.Screen name="plan/[id]" />
      <Stack.Screen name="meal/[id]" />
      <Stack.Screen name="meal-builder" />
      <Stack.Screen name="dish/[id]" />
      <Stack.Screen name="dish-builder" />
      <Stack.Screen name="import-url" />
      <Stack.Screen name="import-image" />
      <Stack.Screen name="import-text" />
      <Stack.Screen name="ask-kiwi" />
      <Stack.Screen name="grocery-list/[id]" />
      <Stack.Screen name="prep-cook" />
      <Stack.Screen name="preferences" />
      <Stack.Screen name="manage-account" />
      {/* D-WS9-257 — "deactivate-account" became "delete-account": the
          pause/reactivate half-feature is gone and DELETE /me is real. */}
      <Stack.Screen name="delete-account" />
      <Stack.Screen name="verify-email" />
      {/* Row 13 "Test Kitchen" · Block 2 — the guest flow. On every platform
          since Resub C1 (Apple 5.1.1(v): the app must be usable without an
          account) — Welcome's "Explore without an account" opens it. They are
          outside (tabs) and outside (auth) because a guest is in neither. */}
      <Stack.Screen name="test-kitchen/index" />
      <Stack.Screen name="test-kitchen/options" />
      <Stack.Screen name="test-kitchen/pick" />
      <Stack.Screen name="test-kitchen/plan" />
      <Stack.Screen name="test-kitchen/recipe" />
      {/* Row 9 (1.1) · OAuth Block 2 Part D — Apple’s Return URL. Registered
          on the Services ID and validated by Apple before the sheet opens;
          with usePopup the flow never navigates here. Outside (auth) because
          (auth) redirects an authenticated visitor away, and someone landing
          on this page may already be signed in. */}
      <Stack.Screen name="auth/apple" />
      {/* Row 9 (1.1) · Stripe S2 Part D — Stripe's success_url / cancel_url.
          PUBLIC, and outside (auth) for the same reason auth/apple is: these are
          URLs Stripe sends people to, the visitor may or may not be signed in on
          web, and an auth bounce on a payment return page is the worst possible
          landing. Neither writes subscription state — the webhook is the truth. */}
      <Stack.Screen name="billing/return" />
      <Stack.Screen name="billing/cancelled" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    // v4 (A1) faces — DM Sans (body/UI) + Fraunces (display/serif).
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Fraunces_500Medium_Italic,
    Fraunces_600SemiBold,
    Fraunces_600SemiBold_Italic,
    Fraunces_700Bold,
    Fraunces_700Bold_Italic,
  });

  // Resub C1 — the guest store is read from SecureStore at boot on native (it
  // is synchronous on web, so this is true at once there). Held with the fonts
  // so the splash covers it and GuestProvider mounts with any stored session.
  const guestStoreReady = useGuestStoreReady();

  useEffect(() => {
    if ((fontsLoaded || fontError) && guestStoreReady) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, guestStoreReady]);

  if ((!fontsLoaded && !fontError) || !guestStoreReady) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <GuestProvider>
              <AppProvider>
                {/* Row 9 (1.1) · Stripe S2 Part D — inside AuthProvider (it only
                    fetches for a signed-in member) and inside QueryClientProvider.
                    ABOVE the navigator, like ToastProvider, because a 402 can
                    arrive on any screen and the sheet must survive the route
                    change that a banner CTA or a "Not now" may cause. */}
                <BillingProvider>
                  <GestureHandlerRootView style={{ flex: 1 }}>
                    <KeyboardProvider>
                      {/* WS9 3d Part 3b-2 — app-level toast host, above the
                          navigator so toasts survive route changes. */}
                      <ToastProvider>
                        <StatusBar style="dark" />
                        <SessionGate />
                        <RootLayoutNav />
                        {/* ONE sheet for the whole app (§2.2 / §2.7). Renders
                            nothing while `sheet` is null, which is every state but
                            the three entry points. */}
                        <PaywallSheet />
                        {/* WEB-1 Part A — the web host for lib/dialog.ts
                            (react-native-web's Alert is an empty stub). LAST,
                            so a dialog overlays the navigator and the paywall.
                            Renders nothing on native. */}
                        <DialogHost />
                      </ToastProvider>
                    </KeyboardProvider>
                  </GestureHandlerRootView>
                </BillingProvider>
              </AppProvider>
            </GuestProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
