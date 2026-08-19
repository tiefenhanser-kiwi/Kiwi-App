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

  // ⚠️ WS9-2 2e Part 4 Item 5 — `bridge` (amber / gold / olive) IS DELETED.
  //
  // It existed for exactly one thing: the teaching arc's five-word ramp, back
  // when each WORD carried a ramp stop and every stop therefore had to clear AA
  // on white. Three net-new browns were computed in OKLCH to satisfy that floor
  // while staying monotonic. Treatment A moved the colour off the words and
  // into a decorative gradient rule, which is non-text and has no floor — so
  // ordinary scale stops do the job and the browns have no reason to exist.
  //
  // Two differently-shaped searches, one of which does not respect .gitignore,
  // found six references and no others: three in the ramp definition and three
  // in the test pinning it. Both were rewritten in the same commit.
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
    // WS9-2 2e Part 4 Item 2 — TERRACOTTA AS A TINT, NOT A FILL. The primary
    // action of a group carries the accent as a pale surface + a full-strength
    // edge and dark ink, rather than as a solid block of terracotta[400].
    //
    // ⚠️ NOT interchangeable with `primary`. This is the treatment for a
    // primary that sits INSIDE a tinted panel among peer cells: a fill there
    // reads as the loudest object on the whole screen and flattens the panel's
    // own tint underneath it. On a plain white card, `primary` is still right.
    //
    // Measured: terracotta[600] on terracotta[50] = 7.04:1 (label + icon, past
    // AA at any size). The terracotta[400] edge is 4.16:1 against its own
    // surface and 3.80:1 against the sage[100] panel it sits on — it clears the
    // 3:1 non-text bar on BOTH sides, which a tint has to, since it has an
    // inside and an outside.
    tint: {
      background: Colors.terracotta[50],
      text:       Colors.terracotta[600],
      border:     Colors.terracotta[400],
      hover:      Colors.terracotta[100],
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
      700: 'Fraunces_700Bold',
    },
    serifItalic: {
      400: 'Fraunces_400Regular_Italic',
      500: 'Fraunces_500Medium_Italic',
      600: 'Fraunces_600SemiBold_Italic',
      700: 'Fraunces_700Bold_Italic',
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
  // Placeholder treatment — shown through when a photo is absent/failed. The
  // warm ramp is reused across the rail card / tonight strip / hero image slots
  // (added WS9 L2b; canonical v4 never captured it — a gap-fill, not a FLAG
  // deviation).
  placeholder: {
    base:     '#e9ddc7',               // fill behind the gradient
    gradient: ['#e6cba6', '#d99e6b'],  // warm 120° ramp
  },
  // Near-opaque paper pill for a legible tag floated over a treated image (e.g.
  // the Featured-plans occasion tag) — opaque enough to need no scrim.
  overlayPill: 'rgba(251, 247, 239, 0.92)',
} as const;

export const Components = {
  tellKiwi: {
    surface:           Colors.sage[600],
    inputBackground:   '#FBF7EF',
    inputPlaceholder:  Colors.neutral[600],
    inputRadius:       Radius.full,
    // WS9-2 2e (D-WS9-162) — the circular send affordance at the input's right
    // edge. ⚠️ THIS IS THE CARD'S ONLY TERRACOTTA FILL. Nothing else on the
    // Tell Kiwi card may be a terracotta fill — the option rows below use
    // terracotta as an ICON TINT on white, which is a different thing.
    sendFill:          Colors.terracotta[400],
    sendGlyph:         '#FBF7EF',
    // The three option rows: solid white surfaces, terracotta icon tint.
    // ⚠️ Replaces the 55%-alpha hairline chips, which measured 2.54:1 against
    // the sage surface — below the 3:1 non-text bar. Their TEXT was 4.62:1,
    // only 0.12 above AA, so the fix had to be a surface, not a darker tint.
    optionSurface:     Colors.neutral[0],
    optionIcon:        Colors.terracotta[400],
    optionTitle:       Colors.neutral[900],
    optionDesc:        Colors.neutral[700],
    // The connector line above the options. LIGHT, per ruling — on sage[600]
    // a lighter tone means MORE contrast, so legibility and the visual
    // intent pull the same direction here. 4.62:1.
    connector:         Palette.text.onSage,
  },
  // WS9-2 2e (D-WS9-160) — the Home teaching arc.
  teachingArc: {
    // ⚠️ WS9-2 2e Part 4 Item 5 — REPLACED, and the DIRECTION IS REVERSED.
    // sage LEFT → terracotta RIGHT, so `plans` is the darkest sage and `cook`
    // the darkest terracotta. The old ramp ran the other way. Ruled; do not
    // "restore" the previous direction.
    //
    // ⚠️ These are no longer TEXT colours. Part 2 painted the five words with
    // them, which forced every stop to clear AA on white and is what produced
    // the muddy interior. They now paint a decorative gradient rule and its
    // dots, which are NON-TEXT and have no contrast floor — hence ordinary
    // scale stops instead of three net-new hand-computed browns.
    //
    // Colors.bridge.amber / gold / olive are DELETED with this change; they
    // existed for that ramp and had no other consumer.
    //
    // For the record, on the arc card's white surface: 8.61 · 2.72 · 1.89 ·
    // 2.27 · 8.00. The pale middle is deliberate and correct for a rule.
    //
    // ⚠️ MUST stay the same length as TeachingArc's STEPS. A test pins that.
    ramp: [
      Colors.sage[700],
      Colors.sage[400],
      Colors.sage[300],
      Colors.terracotta[300],
      Colors.terracotta[600],
    ],
  },
  // WS9-2 2c Commit 8 (D-WS9-130) — renamed from `triedTrueRail`. Values are
  // unchanged; only the dead concept's name is gone.
  //
  // ⚠️ artifacts/design_tokens_4.ts (the canonical v4 token doc) still spells
  // this `triedTrueRail` at :369. That file is GITIGNORED and UNTRACKED, so it
  // is outside the commit surface and was deliberately not edited — changing it
  // would diverge a local copy with no record in history. Reported instead.
  featuredRail: {
    cardWidth:     150,
    imageHeight:   74,
    cardRadius:    Radius.xl,
    pillRadius:    Radius.full,
  },
  activePlanStrip: {
    background:  Colors.neutral[0],
    // WS9-2 2c Commit 7 — 42 (ImageTreatment.thumbSize) -> 56. The this-week
    // card's meal thumbnail now ADOPTS the app's meal-row treatment rather than
    // carrying its own size: PlanReviewMealRow (the plan-item row) renders
    // 56 x 56 at Radius.md, and MealRow (catalog rows) 56 x 56 at Radius.sm.
    // The plan-item value wins — this card shows a plan item.
    // ImageTreatment.thumbSize stays 42 as the canonical v4 value; it simply
    // has no consumer now.
    thumbSize:   56,
    radius:      Radius.xl,
    // ⚠️ WS9-2 2e Part 4 Item 3 — NO CONSUMER. It coloured the card's filled
    // "Start cooking" and outlined "View plan" primaries; both are gone, and the
    // panel that replaced them takes its terracotta from Palette.button.tint.
    // Kept, not deleted, on the ImageTreatment.thumbSize precedent above: it is
    // still the canonical v4 value for this component's accent. Two searches
    // (git grep + a non-gitignore-respecting grep over the repo) found this
    // definition and nothing else.
    cookAccent:  Colors.terracotta[400],
  },
  sectionLabel: {
    fontFamily:  Typography.fontFamily.serif,
    fontStyle:   'italic' as const,
    // WS9-2 2c Commit 4 — neutral[600] is the LOCKED *muted text* value, which
    // is the wrong role for a section heading: the eyebrows read as captions
    // rather than as structure. neutral[800] is the high-emphasis text token.
    color:       Colors.neutral[800],
    cookColor:   Colors.terracotta[400],
    // `dash` REMOVED in WS9-2 2c Commit 4. It had exactly one reader
    // (SectionLabel, which wrapped every label as "— label —"); the eyebrows
    // are now left-aligned and undecorated, so the token had no consumer left.
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
