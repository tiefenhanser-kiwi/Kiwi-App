import React from "react";
import {
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";

// D-WS9-099 — the WS5 "coming soon" Alert is REMOVED, not restyled. Both
// pages are live (lib/legal.ts) and a store submission has to link to them.
// The rejection is handled the way grocery-list/[id].tsx handles the
// Instacart link's: a device with no browser is a warn, not a crash, and the
// user is not shown a dead end they cannot act on.
function openLegal(url: string): void {
  Linking.openURL(url).catch((err: unknown) => {
    console.warn("[welcome] legal openURL rejected", err);
  });
}

type FeatherName = React.ComponentProps<typeof Feather>["name"];

// ── Resub C1 — the three actions ─────────────────────────────────────────
// ⚠️ WELCOME_EXPLORE_LABEL is quoted VERBATIM in the App Review note (Apple
// 5.1.1(v): the app must be usable without an account). Do not reword it.
export const WELCOME_PRIMARY_LABEL = "Start your 14-day free trial";
export const WELCOME_EXPLORE_LABEL = "Explore without an account";
export const WELCOME_SIGN_IN_LABEL = "I already have an account";

/**
 * At or under this window height the hero goes compact. 700 pt takes in the
 * 667 pt window Apple reviewed in (an iPhone app on an iPad runs in an iPhone 8
 * / SE-sized compatibility window — the rejection screenshot measured 1083 ×
 * 1925 px, 9:16) and every real 667 pt phone, and leaves the 812 pt+ phones on
 * the full hero.
 */
export const WELCOME_COMPACT_MAX_HEIGHT = 700;

// The footer's two growth caps at large system text. Measured against the
// 375 × 667 window: at these caps the three buttons and the legal line still
// fit whole above the bottom safe area with the scroll area left above them,
// where uncapped largest-accessibility type (~3.1×) would push the last button
// off the screen — the exact failure this screen was rejected for.
const FOOTER_BUTTON_MAX_SCALE = 2;
const FOOTER_LEGAL_MAX_SCALE = 1.5;

// PRD §3.2 — feature copy. Resub C1 replaced the grocery line: the old one named
// Whole Foods, which is not on Instacart in the US.
const FEATURES: Array<{
  icon: FeatherName;
  title: string;
  body: string;
}> = [
  {
    icon: "calendar",
    title: "Skip the meal-planning stress",
    body: "Kiwi suggests dinners based on what you like, what's in season, and what you already have.",
  },
  {
    icon: "shopping-cart",
    title: "Get groceries without the legwork",
    body: "Kiwi builds your list and sends it to Instacart, or take it to any store.",
  },
  {
    icon: "check-circle",
    title: "Cook with confidence, step by step",
    body: "Prep smarter, cook efficiently, and follow along without thinking — Kiwi handles the sequencing.",
  },
];

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height <= WELCOME_COMPACT_MAX_HEIGHT;
  return (
    <View style={[styles.bg, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="welcome-scroll"
      >
        <View style={[styles.heroWrap, compact && styles.heroWrapCompact]}>
          <View style={[styles.iconCircle, compact && styles.iconCircleCompact]}>
            <Image
              source={require("../../assets/images/kiwi-mark-256.png")}
              style={compact ? styles.iconCompact : styles.icon}
            />
          </View>
          {/* Interim text wordmark — the Deep Kiwi vector mark is a go-live item
              (same treatment as 3a). */}
          <Text style={[styles.brand, compact && styles.brandCompact]}>Kiwi</Text>
          <Text
            style={[styles.tag, compact && styles.tagCompact]}
            // Compact: two lines at most, shrinking to fit before it would cut.
            numberOfLines={compact ? 2 : undefined}
            adjustsFontSizeToFit={compact}
            minimumFontScale={0.8}
          >
            Thought to Table — Streamlined Cooking for Home Chefs
          </Text>
        </View>

        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f.title} style={styles.featureCard}>
              <View style={styles.featureIconWrap}>
                <Feather name={f.icon} size={20} color={Colors.sage[600]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureBody}>{f.body}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      <View
        style={[styles.footer, { paddingBottom: insets.bottom + Spacing[3] }]}
        testID="welcome-footer"
      >
        <Button
          label={WELCOME_PRIMARY_LABEL}
          variant="primary"
          onPress={() => router.push("/(auth)/sign-up")}
          maxFontSizeMultiplier={FOOTER_BUTTON_MAX_SCALE}
          testID="welcome-start-trial"
        />
        <Button
          label={WELCOME_EXPLORE_LABEL}
          variant="secondary"
          onPress={() => router.push("/test-kitchen")}
          maxFontSizeMultiplier={FOOTER_BUTTON_MAX_SCALE}
          testID="welcome-explore"
        />
        <Button
          label={WELCOME_SIGN_IN_LABEL}
          variant="secondary"
          onPress={() => router.push("/(auth)/sign-in")}
          maxFontSizeMultiplier={FOOTER_BUTTON_MAX_SCALE}
          testID="welcome-sign-in"
        />
        <Text style={styles.legalLine} maxFontSizeMultiplier={FOOTER_LEGAL_MAX_SCALE}>
          By continuing you agree to our{" "}
          <Text style={styles.legalLink} onPress={() => openLegal(TERMS_URL)}>
            Terms of Service
          </Text>
          {" "}and{" "}
          <Text style={styles.legalLink} onPress={() => openLegal(PRIVACY_URL)}>
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Resub C1 (Apple, Guideline 4) — THE ACTIONS ARE PINNED. Sept 29 made the
  // whole screen one ScrollView so sign-in could be reached at all, but Apple's
  // reviewer, in a 375 × 667 window, saw the hero, the cards and one button,
  // with the next one sliced by the bottom edge — "crowded and cut off". Now the
  // hero and the cards scroll in the space the footer leaves, and the footer
  // sits above the bottom safe area holding every action. At large system text
  // the footer's buttons grow (capped, see FOOTER_BUTTON_MAX_SCALE) and the
  // scroll area shrinks to give them the room; the two never overlap because
  // the ScrollView is the only thing that can shrink.
  bg: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing[5],
    paddingBottom: Spacing[4],
  },
  heroWrap: { alignItems: "center", marginTop: Spacing[6] },
  heroWrapCompact: { marginTop: Spacing[3] },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: Radius["3xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: Spacing[4],
  },
  // Compact hero: 64 pt mark (was 96), 34 pt wordmark (was 44), 14 pt tagline
  // on 20 pt lines (was 15 on 22), two lines at most.
  iconCircleCompact: { width: 64, height: 64, marginBottom: Spacing[2] },
  icon: { width: 96, height: 96 },
  iconCompact: { width: 64, height: 64 },
  brand: {
    fontSize: 44,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serifItalic[700],
    letterSpacing: -1,
  },
  brandCompact: { fontSize: 34, letterSpacing: -0.75 },
  tag: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    marginTop: Spacing[2],
    paddingHorizontal: Spacing[3],
    lineHeight: 22,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  tagCompact: {
    fontSize: Typography.fontSize.base,
    lineHeight: 20,
    marginTop: Spacing[1],
  },
  features: { gap: Spacing[3], marginTop: Spacing[4] },
  featureCard: {
    flexDirection: "row",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    alignItems: "flex-start",
  },
  featureIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius["2xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  featureTitle: {
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
  },
  featureBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    marginTop: 2,
    lineHeight: 18,
    fontFamily: Typography.face.sans[400],
  },
  // flexShrink 0: the footer is never the part that gives way.
  footer: {
    flexShrink: 0,
    gap: Spacing[3],
    paddingHorizontal: Spacing[5],
    paddingTop: Spacing[3],
    backgroundColor: Colors.neutral[100],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.neutral[300],
  },
  legalLine: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 16,
    fontFamily: Typography.face.sans[400],
  },
  legalLink: {
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textDecorationLine: "underline",
  },
});
