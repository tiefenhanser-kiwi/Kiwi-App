import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Radius, Typography } from "@/constants/tokens";

// WS9 BUG-198 — the active tab needs a signal that is NOT colour.
//
// BUG-157 moved tabBarInactiveTintColor 3.1141:1 -> 5.2627:1 and Hans wants that
// kept. But the active/inactive distinction was carried by HUE ALONE (sage[700]
// green vs a warm brown), and darkening the inactive tint narrowed the gap:
// "at arm's length it's not clear which one you're on."
//
// ⚠️ COLOUR ALONE IS NOT AN ACCEPTABLE FIX HERE, because colour alone is exactly
// what just failed — and a hue-only affordance is also the one that fails for a
// red-green colour-blind user. So the fix adds SHAPE and WEIGHT, and the tint
// contrast is left exactly where BUG-157 put it:
//   1. a short indicator bar that EXISTS on the active tab and is absent
//      otherwise (a presence/absence signal, legible with no colour perception);
//   2. the active label steps up one weight (500 -> 700).
//
// Mechanism note: react-navigation's bottom-tab `tabBarLabelStyle` is STATIC —
// it cannot vary on focus. `tabBarIcon` and `tabBarLabel` are the only per-tab
// slots that receive `focused`, so the bar rides the first and the weight rides
// the second. ⚠️ Supplying `tabBarLabel` opts that tab out of `tabBarLabelStyle`
// entirely, so the label styles below carry the FULL type (size + family), not
// just the weight — dropping either would silently resize every tab label.
// Both wrapped in helpers rather than repeated across five Tabs.Screen blocks.
const INDICATOR_WIDTH = 22;
const INDICATOR_HEIGHT = 3;

function tabIcon(name: React.ComponentProps<typeof Feather>["name"]) {
  return ({ color, focused }: { color: string; focused: boolean }) => (
    <View style={s.iconWrap}>
      <View style={[s.indicator, focused && s.indicatorOn]} />
      <Feather name={name} size={22} color={color} />
    </View>
  );
}

function tabLabel(title: string) {
  return ({ color, focused }: { color: string; focused: boolean }) => (
    <Text style={[s.label, focused && s.labelOn, { color }]}>{title}</Text>
  );
}

const s = StyleSheet.create({
  iconWrap: {
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 4,
  },
  // Always laid out, so the icon does not shift by 3px when a tab is selected.
  indicator: {
    width: INDICATOR_WIDTH,
    height: INDICATOR_HEIGHT,
    borderRadius: Radius.full,
    backgroundColor: "transparent",
  },
  indicatorOn: {
    backgroundColor: Colors.sage[700],
  },
  label: {
    fontSize: Typography.fontSize.xs,
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  labelOn: {
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
  },
});

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const baseHeight = 56;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors.sage[700],
        // WS9 BUG-157 — a DUAL site: this one value tints the tab ICON (non-text,
        // 3:1 floor) AND the tab LABEL (text, 4.5:1). On the bar's own
        // neutral[200] #F1EADC surface, neutral[600] measured 3.1141:1 — the icon
        // cleared, the label did not, and this bar is on every screen.
        // 3.1141 -> 5.2627; active stays 7.1949.
        // ⚠️ WS9 BUG-198 — DO NOT REVERT THIS TO neutral[600] to "restore" the
        // active/inactive gap. The gap is now carried by the indicator bar and
        // the label weight above, which is why the contrast can stay.
        tabBarInactiveTintColor: Colors.neutral[700],
        tabBarStyle: {
          backgroundColor: Colors.neutral[200],
          borderTopColor: Colors.neutral[400],
          borderTopWidth: 1,
          paddingBottom: insets.bottom,
          height:
            Platform.OS === "web" ? 84 : baseHeight + insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: Typography.fontSize.xs,
          fontWeight: Typography.fontWeight.medium,
          fontFamily: Typography.face.sans[500],
        },
        headerShown: false,
      }}
    >
      {/* WS9 3a / G7 — 4-tab bar: Home / Plans / Recipes / Groceries. Order per
          spec §5.2 + mockup (Plans before Recipes). "Recipes" label, meals.tsx
          file kept (OPEN-2). */}
      <Tabs.Screen
        name="index"
        options={{ title: "Home", tabBarIcon: tabIcon("calendar"), tabBarLabel: tabLabel("Home") }}
      />
      <Tabs.Screen
        name="plans"
        options={{ title: "Plans", tabBarIcon: tabIcon("book-open"), tabBarLabel: tabLabel("Plans") }}
      />
      <Tabs.Screen
        name="meals"
        options={{ title: "Recipes", tabBarIcon: tabIcon("bookmark"), tabBarLabel: tabLabel("Recipes") }}
      />
      <Tabs.Screen
        name="groceries"
        options={{ title: "Groceries", tabBarIcon: tabIcon("shopping-bag"), tabBarLabel: tabLabel("Groceries") }}
      />
      {/* Profile EXITS the bar (G7); reached via the Home avatar chip. Kept as a
          route (href: null hides the tab) — no file move (3g owns any restructure). */}
      <Tabs.Screen
        name="profile"
        options={{ href: null, title: "Profile", tabBarIcon: tabIcon("user") }}
      />
    </Tabs>
  );
}
