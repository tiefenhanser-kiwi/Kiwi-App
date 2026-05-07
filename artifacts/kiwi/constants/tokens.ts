// Kiwi design tokens — semantic palette derived from the locked design-tokens.ts spec.
// Imported throughout the app instead of hardcoding hex values.
//
// WS5-5P-fix-tokens — cookbook variant (3b): warm cream/brown neutral
// ramp, deeper terracotta brick, warm shadows, slightly tighter radii,
// +1pt display sizes. Replaces the prior sage-tinted ramp that produced
// a green-on-green wash.

export const KColors = {
  // Sage: ramp largely preserved. 700 stays at brand value so the kiwi
  // mark and active states render consistently across the swap.
  sage: {
    50: "#f1f4ec",
    100: "#e2e9d8",
    200: "#cdd9be",
    300: "#b1c2a0",
    400: "#8fa37e",
    500: "#6e8460",
    600: "#556a4a",
    700: "#3a5235", // brand value — unchanged
    800: "#2a3d28",
    900: "#1a2517",
  },

  // Terracotta: deepened toward fired brick (was vivid orange).
  terracotta: {
    50: "#fbeee5",
    100: "#f5dac0",
    200: "#eebe96",
    300: "#e29d68",
    400: "#c1502a", // PRIMARY ACCENT (was #e07c3a)
    500: "#a84520",
    600: "#893719",
    700: "#6a2913",
  },

  // Neutral: warm cream/brown (was sage-tinted). Critical change —
  // flips green-on-green to paper-on-paper.
  neutral: {
    0: "#ffffff",
    50: "#fdfaf3",
    100: "#f3ecde", // app background — warm paper
    200: "#ede5d2", // nav / surfaces
    300: "#e0d6bd", // header / divider tone
    400: "#cebd9e", // card border
    500: "#b3a282", // strong border
    600: "#8a7d6c", // muted text (warm gray-brown)
    700: "#6b5e4d", // secondary text (warm brown)
    800: "#4a3f30", // high-emphasis text
    900: "#2d2620", // primary text (warm dark)
  },
};

export const KPalette = {
  bg: {
    app: KColors.neutral[100], // paper cream
    card: "#fcf7eb", // cream cards (was pure white)
    header: KColors.neutral[100], // header blends into app
    nav: KColors.neutral[100], // nav blends into app
    overlay: "rgba(45, 38, 32, 0.45)", // warm brown overlay
  },
  text: {
    primary: KColors.neutral[900],
    secondary: KColors.neutral[700],
    muted: KColors.neutral[600],
    placeholder: "#a89a7a", // warm placeholder
    inverse: "#fcf7eb", // cream on dark
    link: KColors.terracotta[400], // links now brick (was sage)
  },
  border: {
    default: "rgba(80, 60, 40, 0.10)", // warm hairline
    muted: "rgba(80, 60, 40, 0.06)",
    sage: KColors.sage[300],
  },
};

export const KSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const KRadius = {
  sm: 8,
  md: 10,
  lg: 12, // 14 → 12 (buttons feel more "panel")
  xl: 14, // 16 → 14 (cards feel like paper, not pillows)
  xxl: 18, // 20 → 18
  pill: 9999,
};

export const KShadow = {
  card: {
    shadowColor: "#5a4030", // warm brown (was sage)
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
};

// TODO(D-WS5-XXX): Load Source Serif 4 via expo-font for display text.
// System serif fallback acceptable for testing.
export const KType = {
  size: {
    xs: 11,
    sm: 12,
    base: 14,
    md: 15,
    lg: 17,
    xl: 21, // +1
    xxl: 25, // +1
    display: 34, // +2
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
  },
};

// Branded vocabulary
export const KCopy = {
  delete: "Compost",
  deleted: "Composted",
  generate: "Build",
  loading: "Kiwi is thinking…",
  planLoad: "Kiwi cooked up",
};

export const KFeatures = {
  FREE_MAX_PLANS: 4,
  FREE_GROCERY_ORDERING: false,
  DEFAULT_TRIAL_DAYS: 30,
};
