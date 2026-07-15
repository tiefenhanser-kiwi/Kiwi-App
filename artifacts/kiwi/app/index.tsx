import { Redirect } from "expo-router";

import { useAuth } from "@/contexts/AuthContext";

export default function Index() {
  const { user, isLoading } = useAuth();

  // While bootstrap is still resolving, render nothing.
  // The root _layout.tsx is holding the splash screen open until fonts
  // load; AuthProvider adds a brief additional wait for /auth/me.
  if (isLoading) {
    return null;
  }

  // Routing state machine (WS7-2 Block C, D-WS5-024): auth → onboarding →
  // home. Each gate reads a server-owned User flag, so the flow survives an
  // app-kill at any stage — on the next cold start this re-evaluates and lands
  // the user back where they left off.
  //
  // WS9 3b follow-up (D-WS9-031): the first-run-destination "arrival" screen
  // was removed as redundant friction (home's Tell Kiwi card + rail already
  // answer "what first?"). Onboarding-complete now routes straight to home.
  // `user.firstRunChoiceMade` still ships on the payload but is no longer read
  // here — it is an inert column pending a schema-removal ruling (D-WS9-031).
  if (!user) {
    return <Redirect href="/(auth)/welcome" />;
  }
  if (!user.onboardingComplete) {
    return <Redirect href="/onboarding-prefs" />;
  }
  return <Redirect href="/(tabs)" />;
}
