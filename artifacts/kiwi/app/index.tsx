import { Redirect } from "expo-router";

import { useAuth } from "@/contexts/AuthContext";

export default function Index() {
  const { isAuthenticated, isLoading } = useAuth();

  // While bootstrap is still resolving, render nothing.
  // The root _layout.tsx is holding the splash screen open until fonts
  // load; AuthProvider adds a brief additional wait for /auth/me.
  if (isLoading) {
    return null;
  }

  if (isAuthenticated) {
    return <Redirect href="/(tabs)" />;
  }
  return <Redirect href="/(auth)/welcome" />;
}
