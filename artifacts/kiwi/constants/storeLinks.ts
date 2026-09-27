// Row 13 "Test Kitchen" · Block 2 Part F (R10) — the store URLs, in ONE place.
//
// They are not known until release. The ruling is explicit about what that means:
// "put them in one constant (null for now) and render nothing while null."
//
// 🔴 NULL IS NOT A PLACEHOLDER TO BE FILLED WITH A GUESS. An App Store URL needs
// the numeric app id, which exists only once the listing does; a Play URL needs
// the applicationId, which is real but whose listing is still in review. A strip
// that links to a 404 is worse than no strip, so the render sites treat null as
// "this feature does not exist yet" rather than as "loading".
//
// Filling these in is the whole of a future one-line change: set the two values,
// and components/GetTheAppStrip.tsx starts rendering.

export const STORE_LINKS: {
  ios: string | null;
  android: string | null;
} = {
  ios: null,
  android: null,
};

/** True when at least one store link exists — the strip's gate. */
export function anyStoreLink(links = STORE_LINKS): boolean {
  return !!links.ios || !!links.android;
}
