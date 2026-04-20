import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { GroceryItem } from "@/lib/mockData";

const CATEGORY_ORDER: GroceryItem["category"][] = [
  "Produce",
  "Protein",
  "Dairy",
  "Pantry",
  "Bakery",
  "Frozen",
];

export default function GroceriesTab() {
  const router = useRouter();
  const { groceries, toggleGrocery, togglePantry, isPremium } = useApp();

  const grouped = useMemo(() => {
    const map: Record<string, GroceryItem[]> = {};
    for (const cat of CATEGORY_ORDER) map[cat] = [];
    for (const item of groceries) (map[item.category] ||= []).push(item);
    return map;
  }, [groceries]);

  const remaining = groceries.filter((g) => !g.checked && !g.inPantry).length;
  const inPantry = groceries.filter((g) => g.inPantry).length;

  const handleSendToRetailer = () => {
    if (!isPremium) {
      router.push("/upgrade");
      return;
    }
    // Adapter wiring: see attached_assets/adapters_*.ts (Instacart / Whole Foods)
    // Stub for now until retailer keys arrive.
    alert("Sending to your retailer (stub — Instacart adapter wiring pending API key).");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title="Groceries"
        subtitle={`${remaining} to buy · ${inPantry} in pantry`}
      />
      <Screen>
        <Card padded style={styles.summary}>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryLabel}>Ready when you are</Text>
            <Text style={styles.summaryTitle}>
              {remaining} items left to buy
            </Text>
          </View>
          <Feather name="shopping-bag" size={28} color={KColors.sage[700]} />
        </Card>

        <View style={{ height: KSpacing.md }} />
        <Button
          label={isPremium ? "Send to Instacart" : "Upgrade to send to Instacart"}
          variant="terra"
          iconLeft={<Feather name="send" size={16} color="#fff" />}
          onPress={handleSendToRetailer}
        />

        <View style={{ height: KSpacing.xl }} />

        {CATEGORY_ORDER.map((cat) => {
          const items = grouped[cat];
          if (!items || items.length === 0) return null;
          return (
            <View key={cat} style={{ marginBottom: KSpacing.xl }}>
              <Text style={styles.catTitle}>{cat}</Text>
              <Card padded={false} style={{ overflow: "hidden" }}>
                {items.map((item, idx) => (
                  <Row
                    key={item.id}
                    item={item}
                    isLast={idx === items.length - 1}
                    onToggle={() => toggleGrocery(item.id)}
                    onPantry={() => togglePantry(item.id)}
                  />
                ))}
              </Card>
            </View>
          );
        })}
      </Screen>
    </View>
  );
}

function Row({
  item,
  isLast,
  onToggle,
  onPantry,
}: {
  item: GroceryItem;
  isLast: boolean;
  onToggle: () => void;
  onPantry: () => void;
}) {
  const dimmed = item.checked || item.inPantry;
  return (
    <Pressable onPress={onToggle} style={[styles.row, !isLast && styles.rowBorder]}>
      <View
        style={[
          styles.check,
          item.checked && {
            backgroundColor: KColors.sage[700],
            borderColor: KColors.sage[700],
          },
        ]}
      >
        {item.checked && <Feather name="check" size={14} color="#fff" />}
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={[
            styles.itemName,
            dimmed && {
              textDecorationLine: "line-through",
              color: KColors.neutral[600],
            },
          ]}
        >
          {item.name}
        </Text>
        <Text style={styles.itemAmount}>{item.amount}</Text>
      </View>
      <Pressable onPress={onPantry} hitSlop={10} style={styles.pantryBtn}>
        <Feather
          name="archive"
          size={16}
          color={item.inPantry ? KColors.terracotta[400] : KColors.neutral[600]}
        />
        <Text
          style={[
            styles.pantryText,
            item.inPantry && { color: KColors.terracotta[400] },
          ]}
        >
          {item.inPantry ? "In pantry" : "Have it"}
        </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: KColors.neutral[200],
    borderColor: KColors.neutral[400],
  },
  summaryLabel: {
    fontSize: KType.size.xs,
    fontWeight: "600",
    color: KColors.sage[600],
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  summaryTitle: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    marginTop: 4,
    fontFamily: "Inter_600SemiBold",
  },
  catTitle: {
    fontSize: KType.size.sm,
    fontWeight: "600",
    color: KColors.sage[600],
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: KSpacing.sm,
    paddingHorizontal: 4,
    fontFamily: "Inter_600SemiBold",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: KColors.neutral[500],
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  itemAmount: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  pantryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
    borderRadius: KRadius.pill,
  },
  pantryText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
});
