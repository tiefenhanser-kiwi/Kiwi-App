import { Stack } from "expo-router";

// TODO(WS2-E): Restore auth guard. During Phase 2A-D, any (auth) screen
// is reachable. Phase 2E will add JWT-based redirect if token is present.
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
