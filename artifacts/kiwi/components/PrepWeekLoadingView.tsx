// Prep the Week — the pending state of the generate call (POST
// /plans/:planId/prep-week). An uncached run takes 30–60 seconds, so instead of
// a spinner the wait teaches something: how to dice an onion, in six panels.
//
// Ported from the approved mockup (Oct 3). Copy is the mockup's, verbatim.
// Two deliberate departures:
//  • The mockup's meta row ("Sorting 5 meals · 41 ingredients / ~19 containers
//    · about 85 min") is gone except its first clause. Ingredients, containers
//    and minutes do not exist until the response lands; the meal count is
//    already in client state, so "Sorting N meals" stays when the container
//    passes one.
//  • The step-number badges print #FFFFFF, not the mockup's paper #FBF7EF:
//    paper on terracotta[400] is 4.4273:1, the same AA miss BUG-106 fixed on
//    the primary button.
//
// LAYOUT. Three rows of two, as the mockup renders. The grid folds to one
// column when a column would hold fewer than ~110pt of 1× text — at a 375pt
// phone that is a system font scale above ~1.5 (the accessibility sizes), at a
// 320pt phone above ~1.26. Every text node wraps freely (no numberOfLines) and
// the whole screen scrolls, so nothing is clipped at any font size.
//
// Presentational only: PrepWeekScreen owns the queries and the ~400 ms delay
// before this mounts. Kept render-only so it's testable under node:test.

import React from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ONION_ART_ASPECT,
  OnionCrossArt,
  OnionHalveArt,
  OnionHorizontalArt,
  OnionLengthwiseArt,
  OnionPeelArt,
  OnionTrimArt,
} from "@/components/cooking/OnionDiceArt";
import {
  Colors,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";

interface OnionStep {
  n: number;
  /** Alternating runs, starting plain: odd indexes are the terracotta words. */
  caption: readonly string[];
  tip: string;
  Art: () => React.JSX.Element;
}

export const ONION_DICE_STEPS: readonly OnionStep[] = [
  {
    n: 1,
    caption: ["Cut off the ", "stem end", " and the ", "root end", "."],
    tip: "Two flat ends make the onion easy to steady.",
    Art: OnionTrimArt,
  },
  {
    n: 2,
    caption: ["", "Peel", " the papery skin and the first tough layer."],
    tip: "Start at the cut top; the skin lifts in one strip.",
    Art: OnionPeelArt,
  },
  {
    n: 3,
    caption: ["Cut in ", "half", ", end to end. Lay each half on its ", "cut side", "."],
    tip: "Cut end toward you and to the right; the root end points away.",
    Art: OnionHalveArt,
  },
  {
    n: 4,
    caption: [
      "Knife flat, from the cut end: ",
      "2–3 horizontal cuts",
      " toward the root — not through it.",
    ],
    tip: "Stop about ½ inch short of the root.",
    Art: OnionHorizontalArt,
  },
  {
    n: 5,
    caption: [
      "",
      "Lengthwise cuts",
      ", stem to root, as close together as you want the dice.",
    ],
    tip: "Stop just short of the root end so the half stays in one piece.",
    Art: OnionLengthwiseArt,
  },
  {
    n: 6,
    caption: [
      "Turn the knife to point away from you and ",
      "cut across",
      " — the dice falls away. Work toward the root; compost the stub.",
    ],
    tip: "Fingertips curled under, knuckles against the flat of the blade. Smaller gaps in 4–6 = finer dice.",
    Art: OnionCrossArt,
  },
];

// ── Column decision ─────────────────────────────────────────────────────────

/** Desktop web: the illustrations scale with their column, so cap the column. */
const MAX_CONTENT_WIDTH = 600;
const GRID_GAP = 10;
/** The narrowest column, in 1× points of text, that still reads as a panel. */
const MIN_COLUMN_AT_1X = 110;

export function onionGridColumns(windowWidth: number, fontScale: number): 1 | 2 {
  const content = Math.min(windowWidth, MAX_CONTENT_WIDTH) - Spacing[4] * 2;
  const column = (content - GRID_GAP) / 2;
  return column / Math.max(fontScale, 1) >= MIN_COLUMN_AT_1X ? 2 : 1;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const BAR_MS = 2400;

/** The mockup's bar: the fill breathes between 38% and 78%, ease-in-out. */
function IndeterminateBar() {
  const t = React.useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) setReduceMotion(on);
      })
      .catch(() => {
        // No answer → motion allowed.
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (reduceMotion) return;
    // Width is a layout prop, so this runs on the JS driver.
    const leg = (toValue: number) =>
      Animated.timing(t, {
        toValue,
        duration: BAR_MS,
        easing: Easing.bezier(0.42, 0, 0.58, 1),
        useNativeDriver: false,
      });
    const loop = Animated.loop(Animated.sequence([leg(1), leg(0)]));
    loop.start();
    return () => loop.stop();
  }, [t, reduceMotion]);

  const width = t.interpolate({ inputRange: [0, 1], outputRange: ["38%", "78%"] });

  return (
    <View
      style={s.barTrack}
      accessibilityRole="progressbar"
      accessibilityLabel="Building your prep list"
    >
      <Animated.View style={[s.barFill, { width }]} />
    </View>
  );
}

function Caption({ runs }: { runs: readonly string[] }) {
  return (
    <Text style={s.caption}>
      {runs.map((run, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={s.captionStrong}>
            {run}
          </Text>
        ) : (
          run
        ),
      )}
    </Text>
  );
}

function Panel({ step }: { step: OnionStep }) {
  const { Art } = step;
  return (
    <View style={s.panel}>
      <View style={s.art} aria-hidden>
        <Art />
      </View>
      <View style={s.badge}>
        <Text style={s.badgeText} maxFontSizeMultiplier={1.6}>
          {step.n}
        </Text>
      </View>
      <Caption runs={step.caption} />
      <Text style={s.tip}>{step.tip}</Text>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export function PrepWeekLoadingView({
  mealCount,
}: {
  /** Meals the run is sorting, when client state already knows it. */
  mealCount?: number;
}) {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const columns = onionGridColumns(width, fontScale);

  const rows: OnionStep[][] = [];
  for (let i = 0; i < ONION_DICE_STEPS.length; i += columns) {
    rows.push(ONION_DICE_STEPS.slice(i, i + columns));
  }

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={[
        s.content,
        { paddingBottom: Spacing[7] + insets.bottom },
      ]}
    >
      <Text style={s.title} accessibilityRole="header">
        Building your prep list…
      </Text>
      <Text style={s.subtitle}>
        Kiwi is grouping this week&apos;s ingredients into containers. The first open
        takes about <Text style={s.subtitleStrong}>30–60 seconds</Text>.
      </Text>

      <IndeterminateBar />
      {mealCount != null && mealCount > 0 ? (
        <Text style={s.meta}>
          Sorting {mealCount} {mealCount === 1 ? "meal" : "meals"}
        </Text>
      ) : null}

      <Text style={s.label}>— while you wait: how to dice an onion —</Text>

      <View style={s.grid}>
        {rows.map((row) => (
          <View key={row[0].n} style={s.row}>
            {row.map((step) => (
              <Panel key={step.n} step={step} />
            ))}
          </View>
        ))}
      </View>

      <View style={s.nextUp}>
        <Text style={s.nextUpText}>
          <Text style={s.nextUpStrong}>Next up:</Text> your containers, in the
          order you&apos;d work a board — dry, then wash, then one knife through all
          the onions, carrots and garlic, then liquids, then proteins.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },

  title: {
    fontSize: 23,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: -0.23,
    marginBottom: Spacing[1],
  },
  subtitle: {
    fontSize: Typography.fontSize.base,
    lineHeight: 20.3,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: 14,
  },
  subtitleStrong: {
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },

  barTrack: {
    height: 6,
    borderRadius: Radius.full,
    backgroundColor: "#EFE7D8", // no token
    overflow: "hidden",
    marginBottom: 6,
  },
  barFill: {
    height: "100%",
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[600],
  },

  // Quiet tier, as the mockup has it — the same token Prep the Week's own
  // container tally uses for once-read status (PrepWeekView `tally`).
  meta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginBottom: 12,
  },
  label: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[600],
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 6,
    marginBottom: Spacing[3],
  },

  grid: { gap: GRID_GAP },
  row: { flexDirection: "row", gap: GRID_GAP },
  panel: {
    flex: 1,
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.xl,
    paddingTop: 10,
    paddingHorizontal: 10,
    paddingBottom: 9,
    ...Shadow.card,
  },
  art: {
    width: "100%",
    aspectRatio: ONION_ART_ASPECT,
    overflow: "hidden",
  },
  badge: {
    position: "absolute",
    top: Spacing[2],
    left: Spacing[2],
    minWidth: 20,
    minHeight: 20,
    paddingHorizontal: 3,
    borderRadius: Radius.full,
    backgroundColor: Colors.terracotta[400],
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: Typography.fontSize.xs,
    color: Palette.button.primary.text,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  caption: {
    fontSize: 13.5,
    lineHeight: 17.55,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[400],
    marginTop: 6,
  },
  captionStrong: {
    color: Colors.terracotta[400],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  tip: {
    fontSize: 11.5,
    lineHeight: 15.5,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 3,
    // The mockup's tip is a <p> that keeps the browser's 1em bottom margin;
    // that air under the tip is part of the approved panel.
    marginBottom: 11.5,
  },

  nextUp: {
    marginTop: 14,
    backgroundColor: Palette.optimization.background,
    borderRadius: Radius.lg,
    paddingVertical: 10,
    paddingHorizontal: Spacing[3],
  },
  nextUpText: {
    fontSize: 12.5,
    lineHeight: 17.5,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  nextUpStrong: {
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
});
