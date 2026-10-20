// BUG-445 — which bundle is running. FIX-7 traced BUG-441 ("no photos in the
// featured preview") to, most likely, a phone still on the embedded 1.1.0
// bundle, and nothing on the device could confirm it. Profile's footer now
// says: the version, the runtime, and the OTA update id — or "built-in" when
// the binary's own bundle is running.
//
// Pure, so it is tested here; app/(tabs)/profile.tsx reads the facts from
// expo-updates and expo-constants and passes them in.

export interface BundleFacts {
  platform: string;
  /** The app config's version (app.json), as the running bundle carries it. */
  version: string | null | undefined;
  /** expo-updates' runtimeVersion. */
  runtimeVersion: string | null | undefined;
  /** expo-updates' updateId: the running OTA update, or null. */
  updateId: string | null | undefined;
  /** expo-updates' isEmbeddedLaunch: the binary's own bundle is running. */
  isEmbeddedLaunch: boolean;
}

/** The first 8 characters of an update id: enough to match `eas update` output. */
export const UPDATE_ID_CHARS = 8;

export function bundleLine(f: BundleFacts): string {
  const parts = [`Version ${f.version || "unknown"}`];
  // The web export has no OTA channel: it is whatever was last deployed.
  if (f.platform === "web") return [...parts, "web"].join(" · ");
  parts.push(`runtime ${f.runtimeVersion || "unknown"}`);
  parts.push(
    f.isEmbeddedLaunch || !f.updateId ? "built-in" : `update ${f.updateId.slice(0, UPDATE_ID_CHARS)}`,
  );
  return parts.join(" · ");
}
