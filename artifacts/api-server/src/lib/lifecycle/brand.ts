// LIFE-1 — the lifecycle emails' colours and fonts.
//
// `artifacts/kiwi/constants/tokens.ts` is the only truth for tokens. This file
// MIRRORS the values the email template needs, because the server image cannot
// import it: the Dockerfile copies `artifacts/api-server` and `lib/api-zod`,
// never `artifacts/kiwi`, so a cross-package import would build locally and
// break the production bundle. `__tests__/lifecycleBrand.test.ts` reads
// tokens.ts and fails on any drift, naming the token path beside each value
// here, so a palette change in the app turns the suite red until this follows.
//
// The dark-mode values are not a second palette: they are stops from the same
// scales (sage 900/800/700, neutral 100/200/400) for the clients that honour
// `prefers-color-scheme` (Apple Mail, iOS Mail, Outlook.com).

export const EMAIL_COLORS = {
  // ── light (the default; inline on every element) ──
  page: "#FBF7EF", //         Colors.neutral[100]  — Palette.background.app, the app's paper
  card: "#ffffff", //         Colors.neutral[0]    — Palette.background.card
  cardBorder: "#E4DCCB", //   Colors.neutral[300]  — the locked card border
  ink: "#2D2A24", //          Colors.neutral[900]  — primary text, headings
  body: "#4A3F30", //         Colors.neutral[800]  — high-emphasis prose
  muted: "#6B5E4D", //        Colors.neutral[700]  — secondary text (5.9:1 on paper)
  button: "#5C7350", //       Colors.sage[600]     — Palette.button.sage.background
  buttonText: "#F4F1E6", //   Palette.button.sage.text
  // ── dark (the @media block only) ──
  darkPage: "#1a2517", //     Colors.sage[900]
  darkCard: "#2a3d28", //     Colors.sage[800]
  darkCardBorder: "#3a5235", // Colors.sage[700]
  darkInk: "#FBF7EF", //      Colors.neutral[100]
  darkBody: "#F1EADC", //     Colors.neutral[200]
  darkMuted: "#D8D0BD", //    Colors.neutral[400]
} as const;

/** Typography.fontFamily.serif / .sans, then fallbacks every client has. No web font is loaded. */
export const EMAIL_FONTS = {
  serif: "Fraunces, Georgia, 'Times New Roman', serif",
  sans: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;

/** Radius.lg — the app's card and button corner. */
export const EMAIL_RADIUS_PX = 12;

/**
 * The Kiwi mark, ALREADY served publicly by the marketing site (kiwi-site
 * `kiwi-mark.png`, 256×256 RGBA, measured 200 image/png on 2026-10-17). A PNG
 * because Gmail does not render SVG. Shown at 40×40 CSS px, so it is sharp at
 * up to 6× density.
 */
export const EMAIL_LOGO_URL = "https://kitchenwizard.ai/kiwi-mark.png";
