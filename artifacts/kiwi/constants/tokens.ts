// Kiwi design tokens — semantic palette derived from the locked design-tokens.ts spec.
// Imported throughout the app instead of hardcoding hex values.

export const KColors = {
  sage: {
    50: "#f4f7f0",
    100: "#e8efe2",
    200: "#d0dbc8",
    300: "#b8ceb0",
    400: "#9ab090",
    500: "#7a9470",
    600: "#5a7254",
    700: "#3a5235",
    800: "#2d4029",
    900: "#1e2a1c",
  },
  terracotta: {
    50: "#fdf2ec",
    100: "#fae0cc",
    200: "#f5c09a",
    300: "#efa068",
    400: "#e07c3a",
    500: "#c86830",
    600: "#a04820",
    700: "#7a3418",
  },
  neutral: {
    0: "#ffffff",
    50: "#fafaf8",
    100: "#f4f7f0",
    200: "#eef2e8",
    300: "#e8efe2",
    400: "#d8e2d0",
    500: "#c8d4c0",
    600: "#9ab090",
    700: "#7a9470",
    800: "#5a7254",
    900: "#1e2a1c",
  },
};

export const KPalette = {
  bg: {
    app: KColors.neutral[100],
    card: KColors.neutral[0],
    header: KColors.neutral[300],
    nav: KColors.neutral[200],
    overlay: "rgba(20, 35, 18, 0.45)",
  },
  text: {
    primary: KColors.neutral[900],
    secondary: KColors.neutral[800],
    muted: KColors.neutral[700],
    placeholder: "#b0c0a8",
    inverse: "#e8efe2",
    link: KColors.sage[700],
  },
  border: {
    default: KColors.neutral[400],
    muted: KColors.neutral[300],
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
  lg: 14,
  xl: 16,
  xxl: 20,
  pill: 9999,
};

export const KShadow = {
  card: {
    shadowColor: "#3a5235",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
};

export const KType = {
  size: {
    xs: 11,
    sm: 12,
    base: 14,
    md: 15,
    lg: 17,
    xl: 20,
    xxl: 24,
    display: 32,
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
