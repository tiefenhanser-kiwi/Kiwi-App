import { Redirect } from "expo-router";

// TODO(WS2-E): Check for stored JWT and redirect to /(tabs) if present.
// During Phase 2A-D, always send to welcome.
export default function Index() {
  return <Redirect href="/(auth)/welcome" />;
}
