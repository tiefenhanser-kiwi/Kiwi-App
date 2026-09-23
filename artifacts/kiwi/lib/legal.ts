// The two legal pages every store submission has to link to, in one place so
// the welcome screen and the Profile tab cannot drift apart.
//
// Verified 200 on 2026-09-22. The `.html` spelling is deliberate: it is the
// form every static host resolves, where the extensionless alias depends on
// the host's pretty-URL setting.
//
// These replace WS5's `showLegalStub` — an Alert reading "Coming soon — Terms
// of Service and Privacy Policy", which is both a dead stub (D-WS9-099) and,
// on a screen that gates account creation, a link to nothing.

export const TERMS_URL = "https://kitchenwizard.ai/terms.html";
export const PRIVACY_URL = "https://kitchenwizard.ai/privacy.html";
