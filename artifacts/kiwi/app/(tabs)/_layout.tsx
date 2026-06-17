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
          fontSize: 11,
          fontWeight: "500",
          fontFamily: Typography.face.sans[500],
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
