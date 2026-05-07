import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useApp } from "@/contexts/AppContext";
import { GROCERY_SECTIONS } from "@/lib/domain";
import { getGroceryListById } from "@/lib/stubs";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import type { GroceryList, GroceryListItem } from "@/lib/types";

export default function GroceryListDetail() {
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === "string" ? rawId : "";
  const {
    toggleGroceryItemCompleted,
    toggleGroceryStapleSelection,
    addGroceryItem,
    markGroceryShoppingDone,
  } = useApp();

  // Optimistic local state. WS5 stubs log-only, so we manage UI state here.
  // WS7 swaps this for live data via the API client.
  const [list, setList] = useState<GroceryList | null>(() =>
    getGroceryListById(id),
  );
  const [addItemInput, setAddItemInput] = useState("");

  if (!list) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack title="Grocery List" />
        <View style={s.notFoundWrap}>
          <Text style={s.notFoundText}>List not found.</Text>
        </View>
      </View>
    );
  }

  const handleToggleItem = (item: GroceryListItem) => {
    void toggleGroceryItemCompleted(list.id, item.id);
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, isCompleted: !it.isCompleted } : it,
            ),
          }
        : prev,
    );
  };

  // Universal staple toggle: flips both the staple-selected affordance and
  // the regular completion check. WS5 collapses both into the
  // isCompleted toggle so the UI shifts visibly when the user "selects"
  // the staple. WS7 splits them when the real model has a separate
  // selection field.
  const handleToggleStaple = (item: GroceryListItem) => {
    void toggleGroceryStapleSelection(list.id, item.id);
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, isCompleted: !it.isCompleted } : it,
            ),
          }
        : prev,
    );
  };

  const handleAddItem = () => {
    const name = addItemInput.trim();
    if (!name) return;
    void addGroceryItem(list.id, name);
    const newItem: GroceryListItem = {
      id: `local-${Date.now()}`,
      name,
      quantity: "1",
      sectionKey: "extras",
      isUniversalStaple: false,
      isRecurringItem: false,
      isAmbiguous: false,
      isOptional: false,
      isCompleted: false,
    };
    setList((prev) =>
      prev ? { ...prev, items: [...prev.items, newItem] } : prev,
    );
    setAddItemInput("");
  };

  const handleMarkDone = () => {
    void markGroceryShoppingDone(list.id, true);
    setList((prev) => (prev ? { ...prev, status: "completed" } : prev));
  };

  const handleUnmarkDone = () => {
    void markGroceryShoppingDone(list.id, false);
    setList((prev) => (prev ? { ...prev, status: "active" } : prev));
  };

  const handleAmbiguousReview = () => {
    Alert.alert(
      "Coming in WS6 — ambiguous item resolution",
      "Resolving flagged items needs the AI orchestration layer.",
    );
  };

  const handleEmail = () => {
    Alert.alert(
      "Coming in WS6 — email integration",
      "Sending grocery lists via email requires server-side template + SES wiring.",
    );
  };

  const handleOrderOnline = () => {
    Alert.alert(
      "Coming in WS6 — retailer integration",
      "Online ordering requires the retailer adapter pattern from PRD §12.12.",
    );
  };

  const handleBackToPlan = () => {
    if (list.planId) {
      router.push({ pathname: "/plan/[id]", params: { id: list.planId } });
    } else {
      router.back();
    }
  };

  const handlePrepCook = () => {
    Alert.alert(
      "Coming with Prep & Cook Hub",
      "Step-by-step cooking guidance lands when the Prep & Cook Hub workstream ships.",
    );
  };

  const subtitle = list.isThisWeek
    ? `${list.planName} · This Week`
    : list.planName;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
        title="Grocery List"
        subtitle={subtitle}
        rightContent={
          <Pressable
            onPress={handleOrderOnline}
            style={({ pressed }) => [
              s.orderHeaderBtn,
              pressed && { opacity: 0.85 },
            ]}
            hitSlop={6}
          >
            <Text style={s.orderHeaderBtnText}>Order →</Text>
          </Pressable>
        }
      />
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {list.ambiguousItemCount > 0 && (
          <View style={s.ambiguousBanner}>
            <View style={s.ambiguousIcon}>
              <Feather
                name="alert-triangle"
                size={20}
                color={KColors.terracotta[500]}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.ambiguousHeading}>
                Kiwi needs a few specifics
              </Text>
              <Text style={s.ambiguousSubtitle}>
                A few items need clarification before adding to online order.
              </Text>
              <Pressable
                onPress={handleAmbiguousReview}
                style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              >
                <Text style={s.ambiguousLink}>
                  Review {list.ambiguousItemCount} flagged items →
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={s.addItemRow}>
          <TextInput
            value={addItemInput}
            onChangeText={setAddItemInput}
            placeholder="Add an item…"
            placeholderTextColor={KColors.neutral[600]}
            style={s.addItemInput}
            returnKeyType="done"
            onSubmitEditing={handleAddItem}
          />
          <Pressable
            onPress={handleAddItem}
            disabled={!addItemInput.trim()}
            style={({ pressed }) => [
              s.addItemBtn,
              !addItemInput.trim() && { opacity: 0.45 },
              pressed && addItemInput.trim() ? { opacity: 0.85 } : null,
            ]}
          >
            <Text style={s.addItemBtnText}>Add</Text>
          </Pressable>
        </View>

        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Email List" variant="secondary" onPress={handleEmail} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Order Online →"
              variant="terra"
              onPress={handleOrderOnline}
            />
          </View>
        </View>

        <View style={s.sectionsWrap}>
          {GROCERY_SECTIONS.map((section) => {
            const items = list.items.filter(
              (i) => i.sectionKey === section.key,
            );
            if (items.length === 0) return null;
            return (
              <View key={section.key} style={s.section}>
                <View style={s.sectionHeaderRow}>
                  <Text style={s.sectionHeader}>{section.label}</Text>
                  <Pressable onPress={() => {}} hitSlop={6}>
                    {/* WS5: tap "+ Add item" focuses the top input via
                        natural tab order; WS6 will pre-target the section. */}
                    <Text style={s.addItemInline}>+ Add item</Text>
                  </Pressable>
                </View>
                <View style={s.itemList}>
                  {items.map((item) => (
                    <GroceryRow
                      key={item.id}
                      item={item}
                      onToggle={() =>
                        item.isUniversalStaple
                          ? handleToggleStaple(item)
                          : handleToggleItem(item)
                      }
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>

        {list.status === "completed" ? (
          <View style={s.completionWrap}>
            <View style={s.completionIcon}>
              <Feather name="check-circle" size={32} color={KColors.sage[700]} />
            </View>
            <Text style={s.completionHeading}>Shopping complete!</Text>
            <Text style={s.completionSubtitle}>
              You've checked off everything on your list.
            </Text>
            <View style={s.completionActions}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Back to Meal Plan"
                  variant="secondary"
                  onPress={handleBackToPlan}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Start Prep & Cook →"
                  variant="terra"
                  onPress={handlePrepCook}
                />
              </View>
            </View>
            <Pressable
              onPress={handleUnmarkDone}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Text style={s.unmarkLink}>Mark as not done</Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.markDoneWrap}>
            <Button
              label="Mark Shopping Done ✓"
              variant="secondary"
              onPress={handleMarkDone}
            />
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function GroceryRow({
  item,
  onToggle,
}: {
  item: GroceryListItem;
  onToggle: () => void;
}) {
  const dimmed = item.isUniversalStaple || item.isCompleted;
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
    >
      <View
        style={[
          s.check,
          item.isCompleted && {
            backgroundColor: KColors.sage[700],
            borderColor: KColors.sage[700],
          },
          item.isUniversalStaple &&
            !item.isCompleted && {
              borderColor: KColors.neutral[400],
              backgroundColor: "transparent",
            },
        ]}
      >
        {item.isCompleted && (
          <Feather name="check" size={14} color={KColors.neutral[0]} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.itemTopRow}>
          <Text
            style={[
              s.itemName,
              item.isCompleted && {
                textDecorationLine: "line-through",
                color: KColors.neutral[600],
              },
              item.isUniversalStaple &&
                !item.isCompleted && {
                  color: KColors.neutral[700],
                },
            ]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          {item.isUniversalStaple && (
            <Tag label="Pantry Staple" tone="muted" />
          )}
          {item.isRecurringItem && <Tag label="Recurring" tone="sage" />}
          {item.isOptional && <Tag label="Optional" tone="muted" />}
        </View>
      </View>
      <Text
        style={[
          s.qty,
          dimmed && { color: KColors.neutral[600] },
        ]}
      >
        {item.quantity}
      </Text>
    </Pressable>
  );
}

function Tag({
  label,
  tone,
}: {
  label: string;
  tone: "sage" | "muted";
}) {
  const palette =
    tone === "sage"
      ? { bg: KColors.sage[100], text: KColors.sage[700] }
      : { bg: KColors.neutral[200], text: KColors.neutral[700] };
  return (
    <View
      style={[
        s.tag,
        { backgroundColor: palette.bg },
      ]}
    >
      <Text style={[s.tagText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
    gap: KSpacing.md,
  },
  notFoundWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.lg,
  },
  notFoundText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  orderHeaderBtn: {
    backgroundColor: KColors.terracotta[400],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
  },
  orderHeaderBtnText: {
    color: KColors.neutral[0],
    fontSize: KType.size.sm,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  ambiguousBanner: {
    flexDirection: "row",
    gap: KSpacing.md,
    backgroundColor: KColors.terracotta[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    padding: KSpacing.md,
  },
  ambiguousIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: KColors.terracotta[100],
    alignItems: "center",
    justifyContent: "center",
  },
  ambiguousHeading: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  ambiguousSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  ambiguousLink: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[500],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: 4,
  },
  addItemRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "stretch",
  },
  addItemInput: {
    flex: 1,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 10,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  addItemBtn: {
    backgroundColor: KColors.sage[700],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  addItemBtnText: {
    color: KColors.neutral[0],
    fontSize: KType.size.md,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  sectionsWrap: {
    gap: KSpacing.lg,
  },
  section: {
    gap: KSpacing.sm,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: KSpacing.xs,
  },
  sectionHeader: {
    fontSize: KType.size.sm,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  addItemInline: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  itemList: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KPalette.border.muted,
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
  itemTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
    flexWrap: "wrap",
  },
  itemName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  qty: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  tag: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 2,
    borderRadius: KRadius.pill,
  },
  tagText: {
    fontSize: 10,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  markDoneWrap: {
    marginTop: KSpacing.lg,
  },
  completionWrap: {
    marginTop: KSpacing.lg,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KColors.sage[200],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  completionIcon: {
    marginBottom: KSpacing.xs,
  },
  completionHeading: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  completionSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  completionActions: {
    flexDirection: "row",
    gap: KSpacing.sm,
    width: "100%",
    marginTop: KSpacing.sm,
  },
  unmarkLink: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textDecorationLine: "underline",
    marginTop: KSpacing.xs,
  },
});
