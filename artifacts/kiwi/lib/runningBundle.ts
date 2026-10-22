// BUG-445 — which bundle is running, read once: none of these change while
// the app runs (a downloaded update applies on the next launch).
//
// SEC-3 E — one place, because two read it: Profile's footer and the line
// "Send feedback" attaches. lib/appBundle.ts stays pure (and tested); this is
// the read from expo-updates and expo-constants.
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

import { bundleLine } from "./appBundle";

export const BUNDLE_LINE = bundleLine({
  platform: Platform.OS,
  version: Constants.expoConfig?.version,
  runtimeVersion: Updates.runtimeVersion,
  updateId: Updates.updateId,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
});
