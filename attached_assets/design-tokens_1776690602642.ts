// kiwi/packages/shared/src/design-tokens.ts
// Single source of truth for all visual constants.
// Import from here — never hardcode colors, spacing, or typography.

export const Colors = {
  // ── PRIMARY PALETTE ──
  sage: {
    50:  '#f4f7f0',
    100: '#e8efe2',
    200: '#d0dbc8',
    300: '#b8ceb0',
    400: '#9ab090',
    500: '#7a9470',
    600: '#5a7254',
    700: '#3a5235',  // ← primary brand green
    800: '#2d4029',
    900: '#1e2a1c',
  },

  terracotta: {
    50:  '#fdf2ec',
    100: '#fae0cc',
    200: '#f5c09a',
    300: '#efa068',
    400: '#e07c3a',  // ← primary accent / CTA
    500: '#c86830',
    600: '#a04820',
    700: '#7a3418',
    800: '#542210',
    900: '#2e1208',
  },

  neutral: {
    0:   '#ffffff',
    50:  '#fafaf8',
    100: '#f4f7f0',  // ← app background
    200: '#eef2e8',  // ← nav background
    300: '#e8efe2',  // ← header background
    400: '#d8e2d0',  // ← card border
    500: '#c8d4c0',  // ← phone border
    600: '#9ab090',  // ← muted nav text
    700: '#7a9470',  // ← subtext / labels
    800: '#5a7254',  // ← secondary text
    900: '#1e2a1c',  // ← primary text
  },
} as const;

export const Palette = {
  // ── SEMANTIC ALIASES ──
  background: {
    app:     Colors.neutral[100],
    card:    Colors.neutral[0],
    header:  Colors.neutral[300],
    nav:     Colors.neutral[200],
    input:   Colors.neutral[0],
    overlay: 'rgba(20, 35, 18, 0.45)',
    sheet:   Colors.neutral[100],
  },

  text: {
    primary:   Colors.neutral[900],
    secondary: Colors.neutral[800],
    muted:     Colors.neutral[700],
    placeholder: '#b0c0a8',
    inverse:   '#e8efe2',
    link:      Colors.sage[700],
    danger:    Colors.terracotta[600],
  },

  border: {
    default:  Colors.neutral[400],
    strong:   Colors.neutral[500],
    muted:    Colors.neutral[300],
    sage:     Colors.sage[300],
    terra:    Colors.terracotta[300],
  },

  button: {
    primary: {
      background: Colors.sage[700],
      text:       '#e8efe2',
      hover:      Colors.sage[800],
    },
    secondary: {
      background: Colors.neutral[100],
      text:       Colors.sage[700],
      border:     Colors.sage[300],
      hover:      Colors.neutral[300],
    },
    terra: {
      background: Colors.terracotta[400],
      text:       '#ffffff',
      hover:      Colors.terracotta[500],
    },
    ghost: {
      background: Colors.neutral[0],
      text:       Colors.sage[700],
      border:     Colors.neutral[400],
      hover:      '#f8faf6',
    },
    destructive: {
      background: 'transparent',
      text:       Colors.terracotta[600],
      border:     Colors.terracotta[300],
    },
  },

  chip: {
    default: {
      background: Colors.neutral[100],
      text:       Colors.sage[600],
      border:     Colors.neutral[400],
    },
    selected: {
      background: Colors.sage[700],
      text:       '#e8efe2',
      border:     Colors.sage[700],
    },
  },

  macro: {
    box: {
      background: '#f8faf6',
      border:     '#e0e8d8',
    },
  },

  optimization: {
    background: 'linear-gradient(135deg, rgba(58,82,53,0.06), rgba(224,124,58,0.06))',
    dot:        Colors.terracotta[400],
  },

  cookMode: {
    current:  Colors.sage[700],
    alert:    'rgba(224,124,58,0.08)',
    alertBorder: 'rgba(224,124,58,0.3)',
    alertText: Colors.terracotta[600],
  },
} as const;

export const Typography = {
  fontFamily: {
    sans:  'DM Sans',
    serif: 'DM Serif Display',
    mono:  'DM Mono',
    // React Native system fallbacks:
    sansRN:  { ios: 'System', android: 'Roboto' },
  },

  fontWeight: {
    regular: '400' as const,
    medium:  '500' as const,
    semibold:'600' as const,
  },

  fontSize: {
    xs:   9,
    sm:   10,
    base: 11,
    md:   12,
    lg:   13,
    xl:   14,
    '2xl': 15,
    '3xl': 17,
    '4xl': 18,
    '5xl': 22,
    '6xl': 26,
    '7xl': 32,
  },

  lineHeight: {
    tight:  1.2,
    snug:   1.35,
    normal: 1.5,
    relaxed: 1.6,
  },

  letterSpacing: {
    tight:  -0.02,
    normal: 0,
    wide:   0.04,
    wider:  0.06,
    widest: 0.12,
  },
} as const;

export const Spacing = {
  0:   0,
  1:   4,
  2:   8,
  3:   12,
  4:   16,
  5:   20,
  6:   24,
  7:   28,
  8:   32,
  10:  40,
  12:  48,
  16:  64,
} as const;

export const Radius = {
  sm:   8,
  md:   10,
  lg:   14,  // buttons
  xl:   16,  // cards
  '2xl': 20,
  '3xl': 28, // overlay sheets
  full: 9999, // pills / chips
} as const;

export const Shadow = {
  // React Native shadows
  card: {
    shadowColor: '#3a5235',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  overlay: {
    shadowColor: '#1e2a1c',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 10,
  },
} as const;

export const Layout = {
  // Max width for web / tablet
  maxWidth: 430,

  // Standard screen padding
  screenPadding: Spacing[4],

  // Header heights
  headerHeight: 56,
  navHeight: 72,
} as const;

// ── LANGUAGE CONSTANTS ──
// Use these everywhere — never use the raw words in UI
export const Copy = {
  delete:   'Compost',
  deleted:  'Composted',
  generate: 'Build',
  loading:  "Kiwi is thinking…",
  planLoad: "Kiwi cooked up",
} as const;

// ── FEATURE FLAGS ──
// These are controlled by environment / admin, not hardcoded
// Import from subscription service at runtime — these are just docs
export const FeatureGates = {
  // Free tier limits
  FREE_MAX_PLANS:           4,
  FREE_GROCERY_ORDERING:    false,
  FREE_FULL_COOK_INTEL:     false,
  FREE_ADS_SHOWN:           true,

  // Trial defaults (override with DEFAULT_TRIAL_DAYS env var)
  DEFAULT_TRIAL_DAYS:       30,
} as const;
