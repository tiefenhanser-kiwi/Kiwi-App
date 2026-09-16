// /(tabs)/playlist — the Playlist tab (WS9 Redesign Arc Block 2b Part A,
// D-WS9-234). The screen is components/PlaylistScreen.tsx so the test glob
// reaches it; this file mounts it. The 2a nudge card ("Start your playlist ›")
// already links here.

import React from "react";

import { PlaylistScreen } from "@/components/PlaylistScreen";

export default function PlaylistTab() {
  return <PlaylistScreen />;
}
