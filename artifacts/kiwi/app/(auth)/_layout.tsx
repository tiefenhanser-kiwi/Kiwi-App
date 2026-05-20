import { Redirect, Stack } from "expo-router";

import { useAuth } from "@/contexts/AuthContext";

export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  if (isAuthenticated) {
    // Route through index.tsx's state machine (WS7-2-E Bug 2) so an
    // authenticated user with incomplete onboarding / first-run choice
    // lands at the right gate instead of jumping straight to home.
    return <Redirect href="/" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
