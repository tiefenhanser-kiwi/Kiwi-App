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
        tabBarInactiveTintColor: Colors.neutral[600],
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
