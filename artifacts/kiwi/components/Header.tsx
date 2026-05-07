import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KColors, KSpacing, KType } from "@/constants/tokens";

interface Props {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
  rightContent?: React.ReactNode;
}

export function Header({
  title,
  subtitle,
  showBack,
  onBack,
  rightIcon,
  onRightPress,
  rightContent,
}: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <View style={styles.row}>
        {showBack ? (
          <Pressable
            onPress={onBack ?? (() => router.back())}
            hitSlop={12}
            style={styles.iconBtn}
          >
            <Feather name="chevron-left" size={24} color={KColors.sage[700]} />
          </Pressable>
        ) : (
          <View style={styles.iconBtn} />
        )}
        <View style={styles.titleWrap}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {rightContent ? (
          <View style={styles.rightSlot}>{rightContent}</View>
        ) : rightIcon ? (
          <Pressable onPress={onRightPress} hitSlop={12} style={styles.iconBtn}>
            <Feather name={rightIcon} size={22} color={KColors.sage[700]} />
          </Pressable>
        ) : (
          <View style={styles.iconBtn} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.lg,
    paddingBottom: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[400],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  rightSlot: {
    minHeight: 40,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingHorizontal: KSpacing.xs,
  },
  titleWrap: { flex: 1, alignItems: "center" },
  title: {
    fontSize: KType.size.lg,
    fontWeight: KType.weight.semibold,
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
});
