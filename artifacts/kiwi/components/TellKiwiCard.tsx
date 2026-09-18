// WS9 L2b — Tell Kiwi card. ONE sage card: the make lane's hero.
//
// WS9-2 2e (D-WS9-162) — REBUILT. Restructured again in Part 4 Item 4.
// WS9 Redesign Arc Block 2a (D-WS9-237) — REBUILT AGAIN as "Create a meal
// plan": the card Hans locked on September 16 after six mockup rounds. Order,
// top to bottom, inside the same sage surface:
//
//   1. title "Create a meal plan" — serif italic, the treatment the "Tell
//      Kiwi" title carried before;
//   2. row 1 — label "Tell Kiwi" (serif italic, on-sage) LEFT of the white
//      pill input, with the rotating placeholder (5 strings, ~2.6s each, short
//      cross-fade — D-WS9-162, unchanged) and a TERRACOTTA ROUND SEND ARROW at
//      its right end. Submit → the merged wizard in TEXT mode;
//   3. the connector — "or let Kiwi take it from here";
//   4. row 2 — a white pill row: sliders icon (sage) · "Have Kiwi use my
//      preferences" · the SAME terracotta round arrow. Tap → the merged wizard
//      in PREFERENCES mode;
//   5. the CONDITIONAL third row, "Set up my Playlist", with its connector
//      above it — D-WS9-163's gate is unchanged (Home passes showAddOwnMeals
//      when the user has NO saved plans). D-WS9-247 re-aimed this row at the
//      Playlist tab (it used to send a new user to the single-meal builder,
//      which predates the Playlist); the prop names keep their §4.5 name.
//
// 🔴 TWO TERRACOTTA ARROWS ON ONE CARD IS DELIBERATE AND HANS-RULED (D-WS9-237
// overrides D-WS9-162's one-emphasis rule for this card). Do not "fix" it to
// one. The conditional third row keeps a sage chevron so the ruling stays
// exactly two — that row is not in the locked mockup.
//
// ⚠️ SURPRISE ME IS GONE (Block 2a Part B). Its row, its handler prop, its copy
// and its wizard source value were removed from the client; the server lane
// deletes its route in parallel. Two entries, equal weight, no third path.
//
// ⚠️ THE CONNECTOR STAYS ON Palette.text.onSage, NOT onSageSub. The mockup
// draws it in the sub tone; that tone measures 3.71:1 on sage[600] — below AA
// (the D-WS9-162 fix that raised it). Hierarchy is carried by weight and size,
// not by tone. Device-tune if Hans wants it quieter.
//
// Presentational + dumb: the input is controlled and every action is a PROP.
// Routing is the Home screen's (§5.1), not this card's.
//
// THERE IS EXACTLY ONE MOUNT: app/(tabs)/index.tsx.

import React from "react";
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import {
  Colors,
  Components,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";

// Copy — verbatim from the locked September 16 mockups.
export const CARD_TITLE = "Create a meal plan";
const TELL_KIWI_LABEL = "Tell Kiwi";
export const CONNECTOR_COPY = "or let Kiwi take it from here";
export const USE_PREFERENCES_LABEL = "Have Kiwi use my preferences";

/**
 * D-WS9-162 — the rotating placeholders, in ruled order. The first is the one
 * the Block 2a mockup draws. Exported so a test can pin them without re-typing
 * (a re-typed copy is a copy that drifts).
 */
export const TELL_KIWI_PLACEHOLDERS = [
  "something cozy for a rainy week…",
  "tacos twice, and something light…",
  "I have chicken and no time…",
  "feed six people on Saturday…",
  "meatless, but not boring…",
] as const;

export const PLACEHOLDER_INTERVAL_MS = 2600;
const FADE_MS = 220;

/**
 * D-WS9-247 — the line above the conditional third option, and its label.
 * Both verbatim from the ruling (Hans, September 18, 2026). Same weight as
 * the card's other connector — not fine print (D-WS9-161's rule carries).
 */
export const ADD_OWN_MEALS_SUBLINE =
  "Have go-to meals? Put them on your Playlist and they'll show up in your plans.";
export const SET_UP_PLAYLIST_LABEL = "Set up my Playlist";

type Props = {
  value?: string;
  onChangeText?: (text: string) => void;
  /** Row 1's send arrow + the keyboard "go" — Home routes to the wizard in TEXT mode. */
  onSubmit?: () => void;
  editable?: boolean;
  /** Row 2 — Home routes to the wizard in PREFERENCES mode. */
  onUsePreferences?: () => void;
  /**
   * §4.5's third option — since D-WS9-247 "Set up my Playlist" (Home routes
   * to the Playlist tab). Renders ONLY when `showAddOwnMeals` is true; Home
   * passes that when the user has NO SAVED PLANS (not when they are "first
   * run" — a user who composts their only plan needs this option and is no
   * longer first-run).
   */
  onAddOwnMeals?: () => void;
  showAddOwnMeals?: boolean;
  /**
   * Test seam ONLY. Forces the reduced-motion branch without an OS query, so
   * the static-placeholder path is exercisable rather than assumed. Production
   * leaves it undefined and the real AccessibilityInfo answer wins.
   */
  __forceReduceMotion?: boolean;
};

/** The terracotta round arrow — row 1's send and row 2's go are the SAME glyph. */
function ArrowButton({
  onPress,
  accessibilityLabel,
  style,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => [styles.arrow, style, pressed && { opacity: 0.85 }]}
    >
      <Feather
        name="arrow-right"
        size={18}
        color={Components.tellKiwi.sendGlyph}
      />
    </Pressable>
  );
}

export function TellKiwiCard({
  value,
  onChangeText,
  onSubmit,
  editable = true,
  onUsePreferences,
  onAddOwnMeals,
  showAddOwnMeals = false,
  __forceReduceMotion,
}: Props) {
  const [index, setIndex] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [reduceMotion, setReduceMotion] = React.useState(
    __forceReduceMotion ?? false,
  );
  const fade = React.useRef(new Animated.Value(1)).current;

  // Ask the OS once. The test seam short-circuits it so the reduced-motion
  // branch does not depend on an async answer landing inside act().
  React.useEffect(() => {
    if (__forceReduceMotion !== undefined) {
      setReduceMotion(__forceReduceMotion);
      return;
    }
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) setReduceMotion(on);
      })
      .catch(() => {
        // No answer → treat as motion-allowed, the pre-2e behaviour.
      });
    return () => {
      alive = false;
    };
  }, [__forceReduceMotion]);

  // ⚠️ ROTATION STOPS on focus and whenever the field holds any text. A
  // placeholder that moves under a live cursor is disorienting, and once the
  // user has typed the placeholder is not even visible — animating it would be
  // burning a timer to redraw something nobody can see.
  const hasText = !!value && value.length > 0;
  const rotating = !reduceMotion && !focused && !hasText;

  React.useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => {
      // Fade out, swap the string at the trough, fade back in.
      Animated.timing(fade, {
        toValue: 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }).start(() => {
        setIndex((i) => (i + 1) % TELL_KIWI_PLACEHOLDERS.length);
        Animated.timing(fade, {
          toValue: 1,
          duration: FADE_MS,
          useNativeDriver: true,
        }).start();
      });
    }, PLACEHOLDER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rotating, fade]);

  // ⚠️ Part 4 Item 4 — FOCUS CLEARS THE VISIBLE STRING, it does not merely stop
  // it moving. Restored on blur when the field is empty. When rotation is off
  // for any OTHER reason (reduce-motion, or text present), still show the first
  // string — never a half-faded frame or whichever one the timer stopped on.
  const placeholder = focused
    ? ""
    : rotating
      ? TELL_KIWI_PLACEHOLDERS[index]
      : TELL_KIWI_PLACEHOLDERS[0];

  return (
    <View style={styles.card}>
      {/* 1 — the card's title. */}
      <Text style={styles.title}>{CARD_TITLE}</Text>

      {/* 2 — row 1: label + input share one row. */}
      <View style={styles.headRow}>
        <Text style={styles.rowLabel}>{TELL_KIWI_LABEL}</Text>
        <View style={styles.inputWrap}>
          {/* The placeholder is rendered as our OWN overlaid Text rather than
              TextInput's placeholder prop: RN cannot cross-fade a native
              placeholder, and swapping the prop outright makes the strings
              snap. The real placeholder prop stays empty so the two can never
              both paint. */}
          <Animated.Text
            pointerEvents="none"
            numberOfLines={1}
            style={[styles.placeholder, { opacity: fade }]}
          >
            {hasText ? "" : placeholder}
          </Animated.Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmit}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder=""
            editable={editable}
            returnKeyType="go"
          />
          <ArrowButton
            onPress={onSubmit}
            accessibilityLabel="Send"
            style={styles.arrowInInput}
          />
        </View>
      </View>

      {/* 3 — the connector. */}
      <Text style={styles.connector}>{CONNECTOR_COPY}</Text>

      {/* 4 — row 2: the preferences path, equal weight, its own arrow. */}
      <View style={styles.options}>
        <Pressable
          onPress={onUsePreferences}
          accessibilityRole="button"
          accessibilityLabel={USE_PREFERENCES_LABEL}
          style={({ pressed }) => [styles.option, pressed && { opacity: 0.85 }]}
        >
          <Feather
            name="sliders"
            size={18}
            color={Components.tellKiwi.optionIcon}
          />
          <Text style={styles.optionTitle} numberOfLines={1}>
            {USE_PREFERENCES_LABEL}
          </Text>
          <ArrowButton
            onPress={onUsePreferences}
            accessibilityLabel="Use my preferences"
          />
        </Pressable>

        {/* 5 — THE CONDITIONAL GATE IS UNCHANGED (D-WS9-163). Both the
            connector AND the option are gated on `showAddOwnMeals`, which Home
            derives from shouldOfferAddOwnMeals(usePlans(["my_plans"]) count):
            true only when the count RESOLVES to zero. Deliberately NOT
            isFirstRun — that stamp is permanent and monotonic. */}
        {showAddOwnMeals && (
          <>
            <Text style={styles.addOwnSub}>{ADD_OWN_MEALS_SUBLINE}</Text>
            <Pressable
              onPress={onAddOwnMeals}
              accessibilityRole="button"
              accessibilityLabel={SET_UP_PLAYLIST_LABEL}
              style={({ pressed }) => [styles.option, pressed && { opacity: 0.85 }]}
            >
              {/* The Playlist tab's own glyph (music), not the builder's pencil. */}
              <Feather
                name="music"
                size={18}
                color={Components.tellKiwi.optionIcon}
              />
              <Text style={styles.optionTitle} numberOfLines={1}>
                {SET_UP_PLAYLIST_LABEL}
              </Text>
              {/* A chevron, not a third terracotta arrow — the two-arrow
                  ruling is exact and this row is outside the mockup. */}
              <Feather
                name="chevron-right"
                size={20}
                color={Components.tellKiwi.optionIcon}
              />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const INPUT_HEIGHT = 44;
const ARROW_SIZE = 34;

const styles = StyleSheet.create({
  card: {
    backgroundColor: Components.tellKiwi.surface,
    borderRadius: Radius["2xl"],
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: 14,
  },
  // The card's title — the serif-italic treatment the "Tell Kiwi" head used to
  // carry (BUG-035: 500 Medium Italic is the face that is loaded; the numeric
  // weight matches it).
  title: {
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
    fontSize: Typography.fontSize.xl,
    color: Palette.text.onSage,
    marginBottom: 12,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
  },
  // Row 1's label — same face as the title, one step down the scale so the
  // title reads as the card's and this as the row's.
  rowLabel: {
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
    fontSize: Typography.fontSize.lg,
    color: Palette.text.onSage,
    // flexShrink so a longer label can never squeeze the input to nothing.
    flexShrink: 0,
  },
  inputWrap: {
    flex: 1,
    minWidth: 0,
    height: INPUT_HEIGHT,
    justifyContent: "center",
    backgroundColor: Components.tellKiwi.inputBackground,
    borderRadius: Components.tellKiwi.inputRadius,
    paddingLeft: 17,
    // room for the arrow + its inset
    paddingRight: ARROW_SIZE + 12,
  },
  // Sits exactly where the input's own text sits, so the swap is invisible.
  placeholder: {
    position: "absolute",
    left: 17,
    right: ARROW_SIZE + 12,
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    fontSize: Typography.fontSize.base,
    color: Components.tellKiwi.inputPlaceholder,
  },
  input: {
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    padding: 0,
  },
  // 🔴 The terracotta round arrow — TWO on this card, ruled (D-WS9-237).
  arrow: {
    width: ARROW_SIZE,
    height: ARROW_SIZE,
    borderRadius: ARROW_SIZE / 2,
    backgroundColor: Components.tellKiwi.sendFill,
    alignItems: "center",
    justifyContent: "center",
  },
  arrowInInput: {
    position: "absolute",
    right: 5,
  },
  // LIGHT, not muted-dark. On a sage[600] surface a lighter tone means MORE
  // contrast: 4.62:1. onSageSub would be 3.71:1 — below AA.
  connector: {
    fontSize: Typography.fontSize.sm,
    color: Components.tellKiwi.connector,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: 14,
    marginBottom: 8,
  },
  options: {
    gap: Spacing[2],
  },
  // Row 2 (and the conditional third row): a white PILL, matching the input's
  // radius, so the two entries read as one pair.
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Components.tellKiwi.optionSurface,
    borderRadius: Components.tellKiwi.inputRadius,
    minHeight: INPUT_HEIGHT,
    paddingLeft: 15,
    paddingRight: 5,
    paddingVertical: 5,
  },
  // Semibold, text2 (neutral[700]) — Hans asked for a shade lighter than ink;
  // tune on device.
  optionTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: Typography.fontSize.base,
    color: Components.tellKiwi.optionTitle,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  // The conditional connector — same treatment as the connector above row 2:
  // the two lines do the same job on the same card. marginTop:6 buys a little
  // extra air above it only, because it opens a new path.
  addOwnSub: {
    fontSize: Typography.fontSize.sm,
    color: Components.tellKiwi.connector,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: 6,
    paddingHorizontal: 2,
  },
});
