import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KColors } from "@/constants/tokens";

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const baseHeight = 56;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: KColors.sage[700],
        tabBarInactiveTintColor: KColors.neutral[600],
        tabBarStyle: {
          backgroundColor: KColors.neutral[200],
          borderTopColor: KColors.neutral[400],
          borderTopWidth: 1,
          paddingBottom: insets.bottom,
          height:
            Platform.OS === "web" ? 84 : baseHeight + insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "500",
          fontFamily: "Inter_500Medium",
        },
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <Feather name="calendar" size={22} color={color} />,
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
        name="plans"
        options={{
          title: "Plans",
          tabBarIcon: ({ color }) => <Feather name="book-open" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="groceries"
        options={{
          title: "Groceries",
          tabBarIcon: ({ color }) => <Feather name="shopping-bag" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
