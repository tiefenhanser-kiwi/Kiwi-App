import React, { useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FilterChipRow } from "@/components/FilterChipRow";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  getFeaturedMeals,
  getHostingMeals,
  getSavedMeals,
  getTopRatedMeals,
} from "@/lib/stubs";
import type { MealSummary } from "@/lib/types";

export interface AddMealsSheetProps {
  visible: boolean;
  /** Current plan id — passed through to import/builder flows via
   *  addToPlanId so WS7 can auto-add the saved meal to this plan. */
  planId: string;
  onClose: () => void;
  /** Called when user picks an existing meal from the list. The
   *  parent screen handles the optimistic add to the unscheduled
   *  cluster (PRD §8.3.8 — new meals land unscheduled). */
  onPickExistingMeal: (meal: MealSummary) => void;
}

type AddMealsFilter = "featured" | "my_meals" | "top_rated" | "hosting";

const FILTER_OPTIONS: { key: AddMealsFilter; label: string }[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function AddMealsSheet({
  visible,
  planId,
  onClose,
  onPickExistingMeal,
}: AddMealsSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [activeFilter, setActiveFilter] =
    useState<AddMealsFilter>("my_meals");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  const visibleMeals = useMemo(() => {
    let source: MealSummary[];
    switch (activeFilter) {
      case "my_meals":
        source = getSavedMeals();
        break;
      case "featured":
        source = getFeaturedMeals();
        break;
      case "top_rated":
        source = getTopRatedMeals();
        break;
      case "hosting":
        source = getHostingMeals();
        break;
    }
    return sortMeals(source, sortKey);
  }, [activeFilter, sortKey]);

  const handlePick = (meal: MealSummary) => {
    onPickExistingMeal(meal);
    onClose();
  };

  const handleWizard = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Running Kitchen Wizard for a single meal requires the AI layer. This will be wired in WS6.",
    );
  };

  const handleAskKiwi = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Searching online recipes requires the AI layer. This will be wired in WS6.",
    );
  };

  const navigateAfterClose = (
    path: "/import-url" | "/import-image" | "/meal-builder",
  ) => {
    onClose();
    // Defer so the sheet's slide-out animation completes before the
    // destination screen mounts.
    setTimeout(
      () =>
        router.push({
          pathname: path,
          params: { addToPlanId: planId },
        }),
      150,
    );
  };

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
          <Text style={s.title}>Add a meal</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={KColors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Section 1: Pick from your meals */}
          <Text style={s.sectionTitle}>Pick from your meals</Text>
          <View style={{ marginTop: KSpacing.sm }}>
            <FilterChipRow<AddMealsFilter>
              options={FILTER_OPTIONS}
              selected={[activeFilter]}
              onToggle={(key) => setActiveFilter(key)}
            />
          </View>
          <View style={[s.sectionTitleRow, { marginTop: KSpacing.sm }]}>
            <Text style={s.sectionLabel}>
              {FILTER_OPTIONS.find((o) => o.key === activeFilter)?.label}
            </Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>
          <View style={s.list}>
            {visibleMeals.length === 0 ? (
              <Text style={s.emptyText}>No meals here yet.</Text>
            ) : (
              visibleMeals.map((meal) => (
                <MealRow
                  key={meal.id}
                  meal={meal}
                  onPress={() => handlePick(meal)}
                />
              ))
            )}
          </View>

          {/* Section 2: Bring in something new */}
          <Text style={[s.sectionTitle, s.sectionGap]}>
            Bring in something new
          </Text>
          <View style={s.list}>
            <PremiumSourceCard
              icon="zap"
              title="Run Kitchen Wizard for one meal"
              subtitle="Premium · coming in WS6 — Kiwi will design a meal that fits this plan"
              onPress={handleWizard}
            />
            <NewSourceCard
              icon="link"
              title="Import from URL"
              subtitle="Paste a recipe link"
              onPress={() => navigateAfterClose("/import-url")}
            />
            <NewSourceCard
              icon="image"
              title="Import from photo"
              subtitle="Take a photo or pick from your library"
              onPress={() => navigateAfterClose("/import-image")}
            />
            <NewSourceCard
              icon="edit-3"
              title="Create manually"
              subtitle="Build a new meal from scratch"
              onPress={() => navigateAfterClose("/meal-builder")}
            />
          </View>

          {/* Section 3: Ask Kiwi for a recommendation (premium-locked) */}
          <Pressable
            onPress={handleAskKiwi}
            style={({ pressed }) => [
              s.askSection,
              s.sectionGap,
              pressed && { opacity: 0.85 },
            ]}
          >
            <View style={s.askHeader}>
              <Text style={s.sectionTitle}>
                Ask Kiwi for a meal recommendation
              </Text>
              <View style={s.premiumPill}>
                <Feather
                  name="lock"
                  size={10}
                  color={KColors.terracotta[700]}
                />
                <Text style={s.premiumPillText}>Premium</Text>
              </View>
            </View>
            <Text style={s.sectionSubtitle}>
              Premium · coming in WS6 — Kiwi will suggest a meal based on
              this plan and your preferences
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function MealRow({
  meal,
  onPress,
}: {
  meal: MealSummary;
  onPress: () => void;
}) {
  const metaParts = [
    meal.cuisineType,
    capitalize(meal.difficulty),
    `${meal.estimatedTimeMinutes} min`,
  ].filter(Boolean);
  const macrosLine = `${meal.caloriesPerServing} cal · ${meal.proteinGPerServing}g P · ${meal.carbsGPerServing}g C · ${meal.fatGPerServing}g F`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.mealRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.thumb, !meal.imageUrl && s.thumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.mealTitle} numberOfLines={1} ellipsizeMode="tail">
          {meal.title}
        </Text>
        <Text style={s.mealMeta} numberOfLines={1} ellipsizeMode="tail">
          {metaParts.join(" · ")}
        </Text>
        <Text style={s.mealMacros} numberOfLines={1} ellipsizeMode="tail">
          {macrosLine}
        </Text>
      </View>
      {meal.timesCooked !== undefined && meal.timesCooked > 0 && (
        <Text style={s.useCount}>Cooked {meal.timesCooked}×</Text>
      )}
    </Pressable>
  );
}

function NewSourceCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.sourceCard, pressed && { opacity: 0.85 }]}
    >
      <View style={s.sourceIcon}>
        <Feather name={icon} size={18} color={KColors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.sourceTitle}>{title}</Text>
        <Text style={s.sourceSubtitle}>{subtitle}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={KColors.neutral[600]} />
    </Pressable>
  );
}

function PremiumSourceCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.premiumCard, pressed && { opacity: 0.85 }]}
    >
      <View style={s.premiumIcon}>
        <Feather name={icon} size={18} color={KColors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.premiumTitleRow}>
          <Text style={s.sourceTitle}>{title}</Text>
          <View style={s.premiumPill}>
            <Feather
              name="lock"
              size={10}
              color={KColors.terracotta[700]}
            />
            <Text style={s.premiumPillText}>Premium</Text>
          </View>
        </View>
        <Text style={s.sourceSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "85%",
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
  sectionLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sectionSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  sectionGap: {
    marginTop: KSpacing.lg,
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: KSpacing.md,
  },
  mealRow: {
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
    width: 48,
    height: 48,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  mealTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  mealMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  mealMacros: {
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
    gap: KSpacing.sm,
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
  sourceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  sourceTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sourceSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  premiumCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
  },
  premiumIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KPalette.bg.card,
    alignItems: "center",
    justifyContent: "center",
  },
  premiumTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
});
