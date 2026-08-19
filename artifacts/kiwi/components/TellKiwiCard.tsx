// WS9 L2b — Tell Kiwi card. ONE sage card: the make lane's hero.
//
// WS9-2 2e (D-WS9-162) — REBUILT. Restructured again in Part 4 Item 4.
//
// ⚠️ THE COPY LINES ARE DIVIDERS. Each one introduces the path BELOW it, and
// that is why the sub-line moved above the input: it was sitting under the
// thing it describes, reading as a footnote to the input rather than as the
// invitation to use it. Order, top to bottom:
//
//   1. the sub-line — "A mood, a cuisine, a whole week…" — INTRODUCING the
//      input beneath it (was below the input);
//   2. title "Tell Kiwi" INLINE, left of the input, sharing one row (frees a
//      full row of height that a stacked headline used to cost);
//   3. the input filling the rest of that row — white, pill-radius, with a
//      circular terracotta send button at its right edge, plus a rotating
//      placeholder (5 strings, ~2.6s each, short cross-fade);
//   4. a LIGHT connector line — "or let Kiwi take it from here";
//   5. "Use my preferences", THEN "Surprise me" (⚠️ reversed from what 2e
//      Part 2 shipped — ruled);
//   6. a CONDITIONAL connector — "or bring in recipes you already love…" —
//      which likewise moved ABOVE the option it introduces;
//   7. "Add my own meals", the conditional third option.
//
// ⚠️ THE SEND BUTTON IS THE CARD'S ONLY TERRACOTTA FILL. The option-row icons
// are a tint on white, which is a different thing. Do not add a second fill.
//
// ⚠️ WHY THE CHIPS WENT AWAY: the previous "✦ Surprise me" / "Use my
// preferences" chips were 55%-alpha hairlines measuring 2.54:1 against the sage
// surface — below the 3:1 non-text bar, so their boundary dissolved. Their TEXT
// was 4.62:1, only 0.12 above AA, so darkening the text was never available as
// a fix. Solid white surfaces are the fix.
//
// Presentational + dumb: the input is controlled and every action is a PROP.
// Routing is the Home screen's (§5.1), not this card's.
//
// THERE IS EXACTLY ONE MOUNT: app/(tabs)/index.tsx. tellkiwi.tsx neither imports
// nor mounts this component (`<TellKiwiInput>` in that file is a TYPE, not this
// card) — do not re-derive "shared component" caution from this file.

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

const DEFAULT_TITLE = "Tell Kiwi";
export const DEFAULT_SUBTITLE =
  "A mood, a cuisine, a whole week — say it however you like.";
const CONNECTOR_COPY = "or let Kiwi take it from here";

/**
 * D-WS9-162 — the rotating placeholders, in ruled order. Exported so a test can
 * pin them without re-typing (a re-typed copy is a copy that drifts).
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

/** D-WS9-161/162 — the sub-line under the conditional third option. */
export const ADD_OWN_MEALS_SUBLINE =
  "or bring in recipes you already love — by link, photo, or paste.";

type Props = {
  value?: string;
  onChangeText?: (text: string) => void;
  onSubmit?: () => void;
  editable?: boolean;
  title?: string;
  subtitle?: string;
  /** ✦ Surprise me — Home wires the surprise-me generation path. */
  onSurprise?: () => void;
  /** Use my preferences — Home wires the prefilled wizard. */
  onUsePreferences?: () => void;
  /**
   * §4.5 — "Add my own meals". Renders ONLY when `showAddOwnMeals` is true;
   * Home passes that when the user has NO SAVED PLANS (not when they are
   * "first run" — a user who composts their only plan needs this option and is
   * no longer first-run).
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

function OptionRow({
  icon,
  title,
  description,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  description: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.option, pressed && { opacity: 0.85 }]}
    >
      <Feather
        name={icon}
        size={18}
        color={Components.tellKiwi.optionIcon}
        style={styles.optionIcon}
      />
      <View style={styles.optionTextCol}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionDesc} numberOfLines={1}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

export function TellKiwiCard({
  value,
  onChangeText,
  onSubmit,
  editable = true,
  title = DEFAULT_TITLE,
  subtitle = DEFAULT_SUBTITLE,
  onSurprise,
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
  // it moving. Rotation already stopped on focus, which left a frozen suggestion
  // sitting under the cursor: the user is typing into a field that still appears
  // to contain someone else's sentence, and the only way to find out it is not
  // real text is to try to delete it.
  //
  // Restored on blur when the field is empty — `focused` goes false, `rotating`
  // goes true again, and the string comes back. A field with text keeps
  // rendering nothing, which is the pre-existing `hasText` behaviour below.
  //
  // When rotation is off for any OTHER reason (reduce-motion, or text present),
  // still show the first string — never a half-faded frame or whichever one the
  // timer happened to stop on.
  const placeholder = focused
    ? ""
    : rotating
      ? TELL_KIWI_PLACEHOLDERS[index]
      : TELL_KIWI_PLACEHOLDERS[0];

  return (
    <View style={styles.card}>
      {/* 1 — the sub-line LEADS. It introduces the input below it; underneath
          the input it read as a footnote to a control the user had already
          decided about. */}
      <Text style={styles.subtitle}>{subtitle}</Text>

      {/* 2 + 3 — title and input share one row. */}
      <View style={styles.headRow}>
        <Text style={styles.title}>{title}</Text>
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
          {/* ⚠️ The card's ONLY terracotta FILL. */}
          <Pressable
            onPress={onSubmit}
            accessibilityRole="button"
            accessibilityLabel="Send"
            hitSlop={8}
            style={({ pressed }) => [styles.send, pressed && { opacity: 0.85 }]}
          >
            <Feather
              name="arrow-right"
              size={18}
              color={Components.tellKiwi.sendGlyph}
            />
          </Pressable>
        </View>
      </View>

      {/* 4 — LIGHT, not muted-dark. On a sage[600] surface a lighter tone means
          MORE contrast, so legibility and the visual intent pull the same way:
          4.62:1. The old onSageSub value would have been 3.71:1 — below AA. */}
      <Text style={styles.connector}>{CONNECTOR_COPY}</Text>

      {/* 5 */}
      <View style={styles.options}>
        {/* ⚠️ Part 4 Item 4 — "Use my preferences" LEADS, and "Surprise me"
            follows. This is REVERSED from what 2e Part 2 shipped and the
            reversal is ruled. */}
        <OptionRow
          icon="sliders"
          title="Use my preferences"
          description="Built from what you already like"
          onPress={onUsePreferences}
        />
        <OptionRow
          icon="zap"
          title="Surprise me"
          description="A full week, chosen for you"
          onPress={onSurprise}
        />
        {/* ⚠️ 6 + 7 — THE CONDITIONAL GATE IS UNCHANGED (D-WS9-163). Both the
            connector AND the option are gated on `showAddOwnMeals`, which Home
            derives from shouldOfferAddOwnMeals(usePlans(["my_plans"]) count):
            true only when the count RESOLVES to zero. While the query is in
            flight the count is UNKNOWN, not zero, and the two-option form
            renders. It is deliberately NOT isFirstRun — that stamp is permanent
            and monotonic, so it would hide this option from exactly the user
            who has composted their only plan and needs it.

            Part 4 Item 4 — the sub-line moved ABOVE the option it introduces,
            like every other copy line on this card. Same string, verbatim,
            naming the three input methods; that is the whole point of the line
            and it is pinned by a test. */}
        {showAddOwnMeals && (
          <>
            <Text style={styles.addOwnSub}>{ADD_OWN_MEALS_SUBLINE}</Text>
            <OptionRow
              icon="edit-3"
              title="Add my own meals"
              description="Start from a recipe you know"
              onPress={onAddOwnMeals}
            />
          </>
        )}
      </View>
    </View>
  );
}

const INPUT_HEIGHT = 44;
const SEND_SIZE = 34;

const styles = StyleSheet.create({
  card: {
    backgroundColor: Components.tellKiwi.surface,
    borderRadius: Radius["2xl"],
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: 14,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
  },
  title: {
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
    fontSize: Typography.fontSize.xl,
    color: Palette.text.onSage,
    // flexShrink so a longer title can never squeeze the input to nothing.
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
    // room for the send button + its inset
    paddingRight: SEND_SIZE + 12,
  },
  // Sits exactly where the input's own text sits, so the swap is invisible.
  placeholder: {
    position: "absolute",
    left: 17,
    right: SEND_SIZE + 12,
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
  send: {
    position: "absolute",
    right: 5,
    width: SEND_SIZE,
    height: SEND_SIZE,
    borderRadius: SEND_SIZE / 2,
    backgroundColor: Components.tellKiwi.sendFill,
    alignItems: "center",
    justifyContent: "center",
  },
  // ⚠️ NOT IN THE 2e RULING, disclosed: this was Palette.text.onSageSub
  // (#D5DCCB), which measures 3.71:1 on sage[600] — below AA. The ruling only
  // required the CONNECTOR to go light, but shipping an accessibility fix to
  // one line of a card while leaving its neighbour failing beside it is not a
  // fix. Raised to the same onSage tone (4.62:1); hierarchy against the
  // connector is carried by WEIGHT (regular vs medium), not by tone.
  //
  // ⚠️ Part 4 Item 4 — fontSize.sm (12) → fontSize.base (14), one step up the
  // scale: it read slightly small on device, and it is now the FIRST line on
  // the card rather than a footnote under the input. marginTop → marginBottom
  // for the same reason — it leads the card, so its spacing belongs beneath it.
  subtitle: {
    fontSize: Typography.fontSize.base,
    color: Palette.text.onSage,
    fontFamily: Typography.face.sans[400],
    marginBottom: 12,
  },
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
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Components.tellKiwi.optionSurface,
    borderRadius: Radius.lg,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  optionIcon: {
    // The icon is a TINT on white, never a fill — the send button owns the
    // card's only terracotta fill.
  },
  optionTextCol: {
    flex: 1,
    minWidth: 0,
  },
  optionTitle: {
    fontSize: Typography.fontSize.base,
    color: Components.tellKiwi.optionTitle,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  optionDesc: {
    fontSize: Typography.fontSize.sm,
    color: Components.tellKiwi.optionDesc,
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
  },
  // ⚠️ Part 4 Item 4 — this is now a CONNECTOR, not a caption. It moved above
  // the option it introduces, so it takes the same treatment as the connector
  // above the first two options (size, tone, and the medium weight): the two
  // lines do the same job on the same card and reading as two different kinds
  // of text would be the tell that one of them is an afterthought.
  //
  // No margins of its own — styles.options already supplies Spacing[2] between
  // every child, and marginTop would stack on top of that gap rather than
  // replace it. marginTop:6 buys a little extra air above it only, because it
  // opens a new path rather than continuing the list above.
  addOwnSub: {
    fontSize: Typography.fontSize.sm,
    color: Components.tellKiwi.connector,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: 6,
    paddingHorizontal: 2,
  },
});
