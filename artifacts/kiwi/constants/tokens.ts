// kiwi design tokens — v4 "Cookbook, evolved (A1 / Fraunces)".
// Locked June 12, 2026 (UX redesign Track 2, ruling A1). Migrated into the
// app June 17, 2026 (WS7-8-pre). This is the canonical token module; it is
// imported throughout the app as "@/constants/tokens".
//
// API note: the live exports are now Colors / Palette / Typography / Spacing
// / Radius / Shadow / ImageTreatment / Components / Layout / Copy /
// FeatureGates. A TEMPORARY back-compat shim at the BOTTOM of this file
// re-exposes the old K-prefixed names (KColors / KPalette / KSpacing /
// KRadius / KShadow / KType / KCopy / KFeatures) so unmigrated files keep
// compiling mid-migration. The shim is removed once every importer is on
// the v4 API.
//
// Deviations from the side-session design-tokens_4.ts (per WS7-8-pre rulings):
//   - FLAG 1: Typography.fontSize PRESERVES the app's current visual sizes
//     (live KType.size values/keys) rather than adopting v4's smaller named
//     scale, which was authored at a different baseline and would shrink all
//     text ~20-30%. cookStep:22 is carried over from v4 for Cook Mode.
//   - FLAG 3: Typography.face adds per-weight face names (DMSans_600SemiBold,
//     Fraunces_500Medium_Italic, …) because RN/Expo resolves weights by
//     family name, not fontWeight, on Android. Use Typography.face.* in
//     StyleSheet fontFamily; fontWeight remains for iOS/semantic intent.
//   - FLAG 5: Typography.fontSize.xxs (10) ratifies the app's live 10px
//     micro-metadata label (used 9× across list/badge rows). Adding the token
//     moves zero pixels; snapping those literals to xs (11) would enlarge every
//     micro-label ~10% on screens not yet redesigned — a design change smuggled
//     in via a lint sweep. (Numbered 5, not 4: FLAG 4 is already the
//     border-solid A1-crispness deviation on Palette.border.default below.
//     WS9 L2/B2, D-WS9-021 RULED.)
//
// Production note: Fraunces + DM Sans load via @expo-google-fonts in
// app/_layout.tsx. Until loaded, RN falls back to system faces.

export const Colors = {
  sage: {
    50:  '#f1f4ec',
    100: '#e2e9d8',
    200: '#cdd9be',
    300: '#b1c2a0',
    400: '#8fa37e',
    500: '#6e8460',
    600: '#5C7350',  // LOCKED A1 secondary accent / Tell Kiwi surface
    700: '#3a5235',  // primary brand green (UNCHANGED — kiwi mark uses this)
    800: '#2a3d28',
    900: '#1a2517',
  },

  terracotta: {
    50:  '#fbeee5',
    100: '#f5dac0',
    200: '#eebe96',
    300: '#e29d68',
    400: '#C24F25',  // LOCKED A1 primary accent (was #c1502a)
    500: '#a84520',
    600: '#893719',
    700: '#6a2913',
    800: '#481b0d',
    900: '#260e07',
  },

  neutral: {
    0:   '#ffffff',
    50:  '#FDFAF4',  // warmest cream (rare)
    100: '#FBF7EF',  // APP BACKGROUND (locked paper)
    200: '#F1EADC',  // surfaces / nav blend
    300: '#E4DCCB',  // LOCKED card border
    400: '#D8D0BD',  // LOCKED stronger border
    500: '#B3A282',  // strong structural border
    600: '#8A8474',  // LOCKED muted text
    700: '#6B5E4D',  // secondary text (warm brown)
    800: '#4A3F30',  // high-emphasis text
    900: '#2D2A24',  // LOCKED ink (primary text)
  },

  gold: {
    text:       '#996E1B',
    background: '#F6E8C8',
  },
} as const;

export const Palette = {
  background: {
    app:     Colors.neutral[100],   // paper #FBF7EF
    card:    Colors.neutral[0],     // WHITE cards (locked A1)
    header:  Colors.neutral[100],
    nav:     Colors.neutral[100],
    input:   Colors.neutral[50],
    overlay: 'rgba(45, 42, 36, 0.45)',
    sheet:   Colors.neutral[100],
  },

  text: {
    primary:     Colors.neutral[900],
    secondary:   Colors.neutral[700],
    muted:       Colors.neutral[600],
    placeholder: '#A89A7A',
    inverse:     '#FBF7EF',
    link:        Colors.terracotta[400],
    danger:      Colors.terracotta[600],
    onSage:      '#F4F1E6',
    onSageSub:   '#D5DCCB',
  },

  border: {
    default:  Colors.neutral[300],   // #E4DCCB — solid (A1 crispness, FLAG 4)
    strong:   Colors.neutral[400],
    muted:    'rgba(80, 60, 40, 0.06)',
    sage:     Colors.sage[300],
    terra:    Colors.terracotta[300],
  },

  button: {
    // LOCKED A1: terracotta is the primary CTA.
    primary: {
      background: Colors.terracotta[400],
      text:       '#FBF7EF',
      hover:      Colors.terracotta[500],
    },
    secondary: {
      background: Colors.neutral[0],
      text:       Colors.neutral[900],
      border:     Colors.neutral[400],
      hover:      Colors.neutral[200],
    },
    sage: {
      background: Colors.sage[600],
      text:       '#F4F1E6',
      hover:      Colors.sage[700],
    },
    ghost: {
      background: 'transparent',
      text:       Colors.neutral[900],
      border:     Colors.neutral[400],
      hover:      Colors.neutral[200],
    },
    destructive: {
      background: 'transparent',
      text:       Colors.terracotta[600],
      border:     Colors.terracotta[300],
    },
  },

  chip: {
    default: {
      background: Colors.neutral[0],
      text:       Colors.neutral[900],
      border:     Colors.neutral[400],
    },
    selected: {
      background: Colors.terracotta[400],
      text:       '#FBF7EF',
      border:     Colors.terracotta[400],
    },
    onSage: {
      background: 'transparent',
      text:       '#F4F1E6',
      border:     'rgba(244, 241, 230, 0.55)',
    },
  },

  badge: {
    trial: {
      background: Colors.gold.background,
      text:       Colors.gold.text,
    },
  },

  macro: {
    box: {
      background: Colors.neutral[0],
      border:     Colors.neutral[300],
    },
  },

  optimization: {
    background: 'rgba(92, 115, 80, 0.07)',
    dot:        Colors.terracotta[400],
  },

  cookMode: {
    current:     Colors.sage[600],
    alert:       'rgba(194, 79, 37, 0.08)',
    alertBorder: 'rgba(194, 79, 37, 0.30)',
    alertText:   Colors.terracotta[600],
    quantity: {
      color:      Colors.terracotta[400],
      fontWeight: '700' as const,
    },
    nextPreview: Colors.neutral[600],
  },
} as const;

export const Typography = {
  fontFamily: {
    sans:  'DM Sans',
    serif: 'Fraunces',
    mono:  'DM Mono',
    sansRN:  { ios: 'System', android: 'Roboto' },
    serifRN: { ios: 'Times New Roman', android: 'serif' },
  },

  // FLAG 3 — per-weight face names loaded via @expo-google-fonts. Use these
  // for StyleSheet `fontFamily`. Keys are numeric font weights.
  face: {
    sans: {
      400: 'DMSans_400Regular',
      500: 'DMSans_500Medium',
      600: 'DMSans_600SemiBold',
      700: 'DMSans_700Bold',
    },
    serif: {
      400: 'Fraunces_400Regular',
      500: 'Fraunces_500Medium',
      600: 'Fraunces_600SemiBold',
    },
    serifItalic: {
      400: 'Fraunces_400Regular_Italic',
      500: 'Fraunces_500Medium_Italic',
      600: 'Fraunces_600SemiBold_Italic',
    },
  },

  fontWeight: {
    regular:  '400' as const,
    medium:   '500' as const,
    semibold: '600' as const,
    bold:     '700' as const,
  },

  // FLAG 1 — PRESERVED current visual sizes (live values/keys), NOT v4's
  // smaller named scale. cookStep carried over from v4.
  fontSize: {
    xxs:     10,   // FLAG 5 — micro-metadata label (D-WS9-021); see header.
    xs:      11,
    sm:      12,
    base:    14,
    md:      15,
    lg:      17,
    xl:      21,
    xxl:     25,
    display: 34,
    cookStep: 22,
  },

  lineHeight: {
    tight:   1.15,
    snug:    1.3,
    normal:  1.5,
    relaxed: 1.65,
  },

  letterSpacing: {
    tight:   -0.01,
    normal:  0,
    wide:    0.04,
    wider:   0.06,
    widest:  0.10,
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
  lg:   12,
  xl:   14,
  '2xl': 18,
  '3xl': 26,
  full: 9999,
} as const;

export const Shadow = {
  card: {
    shadowColor:  '#5a4030',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius:  8,
    elevation:     2,
  },
  overlay: {
    shadowColor:  '#2D2A24',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.10,
    shadowRadius:  18,
    elevation:     8,
  },
} as const;

export const ImageTreatment = {
  overlay: {
    color:     'rgba(194, 79, 37, 0.06)',
    blendMode: 'multiply' as const,
  },
  aspect: {
    railCard:   150 / 74,
    mealCard:   4 / 3,
    hero:       16 / 10,
    thumb:      1,
  },
  radiusRule: 'match-container' as const,
  thumbSize: 42,
} as const;

export const Components = {
  tellKiwi: {
    surface:           Colors.sage[600],
    inputBackground:   '#FBF7EF',
    inputPlaceholder:  Colors.neutral[600],
    inputRadius:       Radius.full,
  },
  triedTrueRail: {
    cardWidth:     150,
    imageHeight:   74,
    cardRadius:    Radius.xl,
    pillRadius:    Radius.full,
  },
  activePlanStrip: {
    background:  Colors.neutral[0],
    thumbSize:   ImageTreatment.thumbSize,
    radius:      Radius.xl,
    cookAccent:  Colors.terracotta[400],
  },
  sectionLabel: {
    fontFamily:  Typography.fontFamily.serif,
    fontStyle:   'italic' as const,
    color:       Colors.neutral[600],
    cookColor:   Colors.terracotta[400],
    dash:        '—',
  },
} as const;

export const Layout = {
  maxWidth:       430,
  screenPadding:  Spacing[4],
  headerHeight:   56,
  navHeight:      72,
} as const;

export const Copy = {
  delete:   'Compost',
  deleted:  'Composted',
  generate: 'Build',
  loading:  'Kiwi is thinking…',
  planLoad: 'Kiwi cooked up',
} as const;

export const FeatureGates = {
  FREE_MAX_PLANS:        4,
  FREE_GROCERY_ORDERING: false,
  FREE_FULL_COOK_INTEL:  false,
  FREE_ADS_SHOWN:        true,
  DEFAULT_TRIAL_DAYS:    30,
} as const;
