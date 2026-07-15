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
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider } from "@/contexts/AppContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { Palette } from "@/constants/tokens";

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

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Palette.background.app } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding-prefs" options={{ presentation: "modal" }} />
      <Stack.Screen name="onboarding-step-3" />
      <Stack.Screen name="wizard" options={{ presentation: "modal" }} />
      <Stack.Screen name="tellkiwi" options={{ presentation: "modal" }} />
      <Stack.Screen name="wizard-results" />
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
      <Stack.Screen name="upgrade" options={{ presentation: "modal" }} />
      <Stack.Screen name="preferences" />
      <Stack.Screen name="manage-account" />
      <Stack.Screen name="deactivate-account" />
      <Stack.Screen name="verify-email" />
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

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AppProvider>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <StatusBar style="dark" />
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </AppProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
