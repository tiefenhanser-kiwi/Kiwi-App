import React from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { RECIPES, Recipe } from "@/lib/mockData";

interface Props {
  visible: boolean;
  excludeId?: string;
  onClose: () => void;
  onPick: (recipe: Recipe) => void;
}

export function SwapSheet({ visible, excludeId, onClose, onPick }: Props) {
  const insets = useSafeAreaInsets();
  const items = RECIPES.filter((r) => r.id !== excludeId);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Swap meal</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={KColors.neutral[800]} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: KSpacing.md, gap: KSpacing.sm }}>
          {items.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => {
                onPick(r);
                onClose();
              }}
              style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
            >
              <Image source={r.image} style={s.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle}>{r.title}</Text>
                <Text style={s.rowMeta}>
                  {r.cuisine} · {r.minutes} min · {r.calories} cal
                </Text>
              </View>
              <Feather
                name="chevron-right"
                size={18}
                color={KColors.neutral[600]}
              />
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "82%",
    backgroundColor: KColors.neutral[100],
    borderTopLeftRadius: KRadius.xl,
    borderTopRightRadius: KRadius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: KColors.neutral[400],
    alignSelf: "center",
    marginTop: KSpacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: "700",
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: KRadius.md,
    backgroundColor: KColors.neutral[300],
  },
  rowTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  rowMeta: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
});
