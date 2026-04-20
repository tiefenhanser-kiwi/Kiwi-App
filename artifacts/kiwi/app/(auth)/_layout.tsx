import { Stack } from "expo-router";
import { useAuth } from "@clerk/expo";
import { Redirect } from "expo-router";

export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (isSignedIn) return <Redirect href="/(tabs)" />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#f4f7f0" },
      }}
    />
  );
}
