import { Redirect } from "expo-router";
import { useAuth } from "@clerk/expo";
import { ActivityIndicator, View } from "react-native";

import { useApp } from "@/contexts/AppContext";
import { KColors } from "@/constants/tokens";

export default function Index() {
  const { isLoaded, isSignedIn } = useAuth();
  const { ready, onboardingComplete } = useApp();

  if (!isLoaded || !ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: KColors.sage[700],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={KColors.neutral[100]} />
      </View>
    );
  }

  if (!isSignedIn) return <Redirect href="/(auth)/welcome" />;
  if (!onboardingComplete) return <Redirect href="/onboarding-prefs" />;
  return <Redirect href="/(tabs)" />;
}
