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
  // first-run-destination → home. Each gate reads a server-owned User flag,
  // so the flow survives an app-kill at any stage — on the next cold start
  // this re-evaluates and lands the user back where they left off.
  if (!user) {
    return <Redirect href="/(auth)/welcome" />;
  }
  if (!user.onboardingComplete) {
    return <Redirect href="/onboarding-prefs" />;
  }
  if (!user.firstRunChoiceMade) {
    return <Redirect href="/first-run-destination" />;
  }
  return <Redirect href="/(tabs)" />;
}
