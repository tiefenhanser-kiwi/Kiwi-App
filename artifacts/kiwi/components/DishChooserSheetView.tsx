// WS7-6 C-fix Block 4 — presentational Meal→Add-Dish sheet.
//
// Pure/data-injected: the dish list + pagination flags + sort arrive via props
// (the container DishChooserSheet wires the real `useDishes` catalog). Kept in
// its own module — free of any data-hook imports — so it stays unit-testable
// and so WS9 can reuse the create-modes UI without dragging the data wiring in.

import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  DISH_DISABLED_SORT_KEYS,
  DISH_SORT_LABEL_OVERRIDES,
} from "@/lib/dishes/sortMapping";
import { formatMacroLine } from "@/lib/format/macros";
import type { SavedDish } from "@/lib/types";

export interface DishChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called when user picks a saved dish OR adds a Simple Dish. */
  onPickSavedDish: (dish: SavedDish) => void;
  /** WS7-6 Block 1H — "Create from scratch" handler. Appends a blank
   *  editable dish to the meal under construction (parent owns the
   *  state). Kept as a clean callback prop so the sheet stays unaware
   *  of meal-builder internals — WS9 plans to revisit these sheet
   *  create-modes for reuse/extraction, and this keeps that clean. */
  onAddEmptyDish: () => void;
  /** Ask Kiwi (dish-side Mode A) submission. WS7-6 G2: the Meal Builder mount
   *  passes this to navigate to the dish "Ask Kiwi" screen. When absent (a
   *  future reuse that hasn't wired it), the card falls back to an alert. */
  onAskKiwi?: (prompt: string) => void;
}

export interface DishChooserSheetViewProps extends DishChooserSheetProps {
  dishes: SavedDish[];
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  dishesLoading: boolean;
  dishesError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onEndReached: () => void;
  onRetryDishes: () => void;
}

export function DishChooserSheetView({
  visible,
  onClose,
  onPickSavedDish,
  onAddEmptyDish,
  onAskKiwi,
  dishes,
  sortKey,
  onSortChange,
  dishesLoading,
  dishesError,
  isFetchingNextPage,
  onEndReached,
  onRetryDishes,
}: DishChooserSheetViewProps) {
  const insets = useSafeAreaInsets();

  // Modal renders outside the parent's KeyboardAwareScrollViewCompat tree, so
  // any sheet TextInput needs its own keyboard avoidance + explicit dismissal
  // on close — otherwise the keyboard can persist after the sheet hides.
  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };

  const handlePickSaved = (dish: SavedDish) => {
    Keyboard.dismiss();
    onPickSavedDish(dish);
    onClose();
  };

  // WS7-6 G2 — Ask Kiwi is LIVE when the parent passes onAskKiwi (the Meal
  // Builder mount does). The Alert is a defensive fallback for any future
  // mount that reuses this sheet without wiring the dish-side Mode A.
  const handleSubmitAsk = (prompt: string) => {
    Keyboard.dismiss();
    if (onAskKiwi) {
      onAskKiwi(prompt);
    } else {
      Alert.alert(
        "Ask Kiwi isn't available here yet",
        "Kiwi will draft a dish from your description once this surface wires it up.",
      );
    }
  };

  const handleSubmitSimpleDish = (name: string) => {
    Keyboard.dismiss();
    const newDish: SavedDish = {
      id: `simple-dish-${Date.now()}`,
      name,
      type: "side",
      ingredients: [{ quantity: 1, unit: "whole", name }],
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
      mealUseCount: 0,
      createdAt: new Date().toISOString(),
    };
    onPickSavedDish(newDish);
    onClose();
  };

  // WS7-6 Block 1H — append a blank editable dish to the meal under
  // construction (parent owns dishes[]). Create-from-scratch stays in-sheet.
  const handleCreateFromScratch = () => {
    Keyboard.dismiss();
    onAddEmptyDish();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <Pressable style={s.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={s.kbAvoidWrap}
        pointerEvents="box-none"
      >
        <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
          <View style={s.handle} />
          <View style={s.header}>
            <Text style={s.title}>Add a dish</Text>
            <Pressable onPress={handleClose} hitSlop={12}>
              <Feather name="x" size={22} color={KColors.neutral[800]} />
            </Pressable>
          </View>

          {/* FlatList-as-root: the three add-method cards + My Dishes header are
              the ListHeaderComponent; the My Dishes rows are the list data with
              true onEndReached infinite scroll (the sheet's Modal is its own
              portal, so nothing nests this list inside another scroller — no
              "Load more" footer needed, unlike Mode-C). */}
          <FlatList<SavedDish>
            data={dishes}
            keyExtractor={(d) => d.id}
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <DishChooserHeader
                sortKey={sortKey}
                onSortChange={onSortChange}
                onSubmitAsk={handleSubmitAsk}
                onSubmitSimpleDish={handleSubmitSimpleDish}
                onCreateFromScratch={handleCreateFromScratch}
              />
            }
            renderItem={({ item }) => (
              <DishChooserRow dish={item} onPress={() => handlePickSaved(item)} />
            )}
            ItemSeparatorComponent={() => <View style={{ height: KSpacing.sm }} />}
            // Prefetch-ahead while still 50% of a viewport from the end
            // (matches Recipes→Dishes; Hans-ruled threshold).
            onEndReachedThreshold={0.5}
            onEndReached={onEndReached}
            ListEmptyComponent={
              dishesLoading ? (
                <Text style={s.statusText}>Loading your dishes…</Text>
              ) : dishesError ? (
                <View style={s.errorRow}>
                  <Text style={s.statusText}>
                    Couldn&apos;t load your dishes.
                  </Text>
                  <Button label="Retry" variant="ghost" onPress={onRetryDishes} />
                </View>
              ) : (
                <Text style={s.statusText}>
                  You haven&apos;t saved any dishes yet.
                </Text>
              )
            }
            // Footer spinner for next-page fetches only — first-page load shows
            // in ListEmptyComponent, so the list is never replaced mid-scroll.
            ListFooterComponent={
              isFetchingNextPage ? (
                <View style={s.footerLoading}>
                  <ActivityIndicator size="small" color={KColors.sage[700]} />
                </View>
              ) : null
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────
// List header — the three add-method cards (reordered: Ask Kiwi → Add
// Simple Dish → Create from Scratch) followed by the My Dishes section
// title + sort control, which sits directly above the dish rows.
//
// Owns its own create-form UI state (ask prompt, simple-dish expand/name)
// so the sheet view doesn't have to thread it — keeps the create-modes
// self-contained for WS9 extraction.
// ─────────────────────────────────────────────────────────────────
export interface DishChooserHeaderProps {
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  onSubmitAsk: (prompt: string) => void;
  onSubmitSimpleDish: (name: string) => void;
  onCreateFromScratch: () => void;
}

export function DishChooserHeader({
  sortKey,
  onSortChange,
  onSubmitAsk,
  onSubmitSimpleDish,
  onCreateFromScratch,
}: DishChooserHeaderProps) {
  const [askPrompt, setAskPrompt] = useState("");
  const [simpleDishExpanded, setSimpleDishExpanded] = useState(false);
  const [simpleDishName, setSimpleDishName] = useState("");

  const handleAsk = () => {
    const prompt = askPrompt.trim();
    if (!prompt) return;
    onSubmitAsk(prompt);
    setAskPrompt("");
  };

  const handleAddSimpleDish = () => {
    const trimmed = simpleDishName.trim();
    if (!trimmed) return;
    onSubmitSimpleDish(trimmed);
    setSimpleDishName("");
    setSimpleDishExpanded(false);
  };

  const handleCancelSimpleDish = () => {
    Keyboard.dismiss();
    setSimpleDishName("");
    setSimpleDishExpanded(false);
  };

  return (
    <View>
      {/* Section 1: Ask Kiwi (dish-side Mode A — premium, gated server-side) */}
      <View style={s.askSection}>
        <View style={s.askHeader}>
          <Text style={s.sectionTitle}>Ask Kiwi</Text>
          <View style={s.premiumPill}>
            <Feather name="lock" size={10} color={KColors.terracotta[700]} />
            <Text style={s.premiumPillText}>Premium</Text>
          </View>
        </View>
        <Text style={s.sectionSubtitle}>
          Describe a dish and Kiwi drafts the ingredients and steps
        </Text>
        <View style={s.askRow}>
          <TextInput
            value={askPrompt}
            onChangeText={setAskPrompt}
            placeholder="Describe what you want — 'roasted broccoli with garlic and lemon' — Kiwi will draft it"
            placeholderTextColor={KColors.neutral[600]}
            style={s.askInput}
            multiline
            returnKeyType="send"
            blurOnSubmit
            onSubmitEditing={handleAsk}
          />
          <Pressable
            onPress={handleAsk}
            disabled={askPrompt.trim().length === 0}
            style={({ pressed }) => [
              s.askBtn,
              askPrompt.trim().length === 0 && { opacity: 0.4 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={s.askBtnText}>Ask Kiwi</Text>
          </Pressable>
        </View>
      </View>

      {/* Section 2: Add Simple Dish (inline expandable) */}
      {!simpleDishExpanded ? (
        <Pressable
          onPress={() => setSimpleDishExpanded(true)}
          style={({ pressed }) => [
            s.simpleDishCollapsed,
            pressed && { opacity: 0.85 },
          ]}
          testID="dish-chooser-add-simple-dish"
        >
          <View style={{ flex: 1 }}>
            <Text style={s.sectionTitle}>Add Simple Dish</Text>
            <Text style={s.sectionSubtitle}>
              Store-bought sides, simple plating, leftovers
            </Text>
          </View>
          <Feather name="plus" size={18} color={KColors.sage[700]} />
        </Pressable>
      ) : (
        <View style={s.simpleDishExpanded}>
          <Text style={s.sectionTitle}>Add Simple Dish</Text>
          <Text style={s.sectionSubtitle}>
            Store-bought sides, simple plating, leftovers
          </Text>
          <TextInput
            value={simpleDishName}
            onChangeText={setSimpleDishName}
            placeholder="What is it? (e.g., Bag of Lay's Classic Chips, Leftover pizza, Trader Joe's gnocchi)"
            placeholderTextColor={KColors.neutral[600]}
            style={s.simpleDishInput}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={handleAddSimpleDish}
            autoFocus
          />
          <View style={s.simpleDishActionsRow}>
            <View style={{ flex: 1 }}>
              <Button
                label="Add"
                variant="primary"
                disabled={simpleDishName.trim().length === 0}
                onPress={handleAddSimpleDish}
              />
            </View>
            <Pressable
              onPress={handleCancelSimpleDish}
              hitSlop={6}
              style={({ pressed }) => [s.cancelLink, pressed && { opacity: 0.6 }]}
            >
              <Text style={s.cancelLinkText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Section 3: Create from scratch — appends a blank editable dish to the
          current meal (WS7-6 Block 1H) so the user can fill it inline. */}
      <Pressable
        onPress={onCreateFromScratch}
        style={({ pressed }) => [
          s.simpleDishCollapsed,
          pressed && { opacity: 0.85 },
        ]}
        testID="dish-chooser-create-from-scratch"
      >
        <View style={{ flex: 1 }}>
          <Text style={s.sectionTitle}>Create from scratch</Text>
          <Text style={s.sectionSubtitle}>
            Add a blank dish and edit it inline
          </Text>
        </View>
        <Feather name="plus" size={18} color={KColors.sage[700]} />
      </Pressable>

      {/* Section 4: My Dishes — list header + sort. The rows render below as
          FlatList data (server-sorted; the dropdown drives ?sort=). */}
      <View style={[s.sectionTitleRow, { marginTop: KSpacing.lg }]}>
        <Text style={s.sectionTitle}>My Dishes</Text>
        <SortDropdown
          value={sortKey}
          onChange={onSortChange}
          labelOverrides={DISH_SORT_LABEL_OVERRIDES}
          disabledKeys={DISH_DISABLED_SORT_KEYS}
        />
      </View>
      <View style={{ height: KSpacing.sm }} />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// One My Dishes row. Meta line carries cuisine + cook time, the per-serving
// macro line is additive below it, and "Used in N meals" reads the real
// live-meal count (mealUseCount).
// ─────────────────────────────────────────────────────────────────
export interface DishChooserRowProps {
  dish: SavedDish;
  onPress: () => void;
}

export function DishChooserRow({ dish, onPress }: DishChooserRowProps) {
  const metaParts = [
    dish.cuisineType,
    dish.estimatedTimeMinutes && dish.estimatedTimeMinutes > 0
      ? `${dish.estimatedTimeMinutes} min`
      : null,
  ].filter(Boolean) as string[];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.dishRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.thumb, !dish.imageUrl && s.thumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.dishName}>{dish.name}</Text>
        {metaParts.length > 0 && (
          <Text style={s.dishMeta}>{metaParts.join(" · ")}</Text>
        )}
        <Text style={s.dishMacros}>
          {formatMacroLine(
            dish.caloriesPerServing,
            dish.proteinGPerServing,
            dish.carbsGPerServing,
            dish.fatGPerServing,
          )}
        </Text>
      </View>
      {dish.mealUseCount > 0 && (
        <Text style={s.useCount}>
          Used in {dish.mealUseCount}{" "}
          {dish.mealUseCount === 1 ? "meal" : "meals"}
        </Text>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  kbAvoidWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    // Anchor the sheet at ~85% of screen so the picker isn't a tiny
    // strip when content is short. Keyboard avoidance still pushes
    // the keyboard-relevant content up via KeyboardAvoidingView.
    height: "85%",
  },
  sheet: {
    flex: 1,
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
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sectionSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  statusText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  errorRow: {
    gap: KSpacing.sm,
  },
  footerLoading: {
    paddingVertical: KSpacing.md,
    alignItems: "center",
  },
  dishRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  dishName: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dishMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  dishMacros: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  askSection: {
    backgroundColor: KColors.neutral[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    opacity: 0.95,
  },
  askHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  askRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
    alignItems: "flex-end",
  },
  askInput: {
    flex: 1,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    minHeight: 60,
    textAlignVertical: "top",
  },
  askBtn: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  askBtnText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  simpleDishCollapsed: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    marginTop: KSpacing.lg,
  },
  simpleDishExpanded: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
  },
  simpleDishInput: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.sm,
  },
  simpleDishActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    marginTop: KSpacing.xs,
  },
  cancelLink: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.sm,
  },
  cancelLinkText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
