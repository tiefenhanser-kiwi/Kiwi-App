import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Typography } from "@/constants/tokens";

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
        // Active is sage[700] (green) against a warm brown, so active/inactive
        // is carried by HUE, not by value alone: darkening the inactive tint
        // cannot flatten the affordance. 3.1141 -> 5.2627; active stays 7.1949.
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
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <Feather name="calendar" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="plans"
        options={{
          title: "Plans",
          tabBarIcon: ({ color }) => <Feather name="book-open" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="meals"
        options={{
          title: "Recipes",
          tabBarIcon: ({ color }) => <Feather name="bookmark" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="groceries"
        options={{
          title: "Groceries",
          tabBarIcon: ({ color }) => <Feather name="shopping-bag" size={22} color={color} />,
        }}
      />
      {/* Profile EXITS the bar (G7); reached via the Home avatar chip. Kept as a
          route (href: null hides the tab) — no file move (3g owns any restructure). */}
      <Tabs.Screen
        name="profile"
        options={{
          href: null,
          title: "Profile",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
