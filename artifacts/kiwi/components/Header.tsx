import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors, Spacing, Typography } from "@/constants/tokens";

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
            // Sept 29 design review — an unlabelled Feather glyph announces as
            // nothing useful. This one Pressable is the back affordance on ~35
            // screens, Cook Mode among them, so the label lands everywhere at
            // once.
            //
            // ⚠️ THE RIGHT SLOT DELIBERATELY GETS NO LABEL PROP. The review
            // asked for one; `rightIcon` turns out to have ZERO callers (both
            // right-slot users pass `rightContent`), so the prop would have
            // shipped dead. The two live nodes are already right: meal detail's
            // HeartButton carries its own role + label, and Plan Review's
            // "Saved" pill is static text, not a control.
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.iconBtn}
          >
            <Feather name="chevron-left" size={24} color={Colors.sage[700]} />
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
            <Feather name={rightIcon} size={22} color={Colors.sage[700]} />
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
    backgroundColor: Colors.neutral[300],
    paddingHorizontal: Spacing[4],
    paddingBottom: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[400],
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
    paddingHorizontal: Spacing[1],
  },
  titleWrap: { flex: 1, alignItems: "center" },
  title: {
    fontSize: Typography.fontSize.lg,
    fontWeight: Typography.fontWeight.semibold,
    color: Colors.neutral[900],
    // v4: screen/card titles render Roman Fraunces (serif).
    fontFamily: Typography.face.serif[600],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
