// Resub C5 — the Pick screen's meal preview: read the meal, THEN pick it.
//
// Hans, October 7: "adding that meal detail preview before requiring the user
// to add it to a plan … the click to see details before adding to a plan would
// be great because it's right there for the user." A tap on a Pick card's body
// opens this sheet OVER the Pick screen — never a route change, because the
// picks live in PickMealsScreen's state and must survive the look.
//
// What it shows: the card's image at once (the shelf row's imageUrl, already in
// hand), title, the card's time line, difficulty, servings once the detail
// lands, then the recipe — ingredients by dish and the steps — through
// components/MealRecipeSections.tsx, the guest recipe screen's own body (which
// calls lib/format/ingredientLine.ts and lib/meals/mealSteps.ts: no third
// renderer).
//
// ONE read, either principal: GET /meals/:id. A guest reads the public catalog
// meal under the guest token (the route is requireGuestOrAuth; the cache key is
// the guest recipe screen's, ["guest","meal",id]); a member reads as a user
// (useMeal's key, ["meals","detail",id,null], so the member detail screen opens
// warm). The footer is the pick toggle and Close — nothing else. For a guest
// there is no favourite, playlist or save here: those are doors, and a preview
// is not where a visitor meets one.
//
// Shell: GuestDoorSheet's shape (Modal + backdrop + handle + header + scroll),
// as PaywallSheet took it. There is no shared sheet primitive in this codebase
// (MealIngredientsSheetView's header says so) and this does not introduce one.
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { LoadingShim } from "@/components/LoadingShim";
import { timeLine } from "@/components/MealPickCard";
import { MealRecipeSections } from "@/components/MealRecipeSections";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { trackGuestEvent } from "@/lib/api/guest";
import { getMeal, type MealDetail } from "@/lib/api/meals";
import type { ShelfMeal } from "@/lib/api/wizard";

export const PREVIEW_ADD = "Add to my picks";
export const PREVIEW_REMOVE = "Remove from my picks";
export const PREVIEW_CLOSE = "Close";
export const PREVIEW_LOADING = "Opening the recipe…";
export const PREVIEW_ERROR_TITLE = "Kiwi got distracted. Try again?";

/** The footer's one primary — what a tap on it will do to the pick. */
export function previewToggleLabel(picked: boolean): string {
  return picked ? PREVIEW_REMOVE : PREVIEW_ADD;
}

export interface MealPreviewSheetProps {
  /** The shelf row being previewed, or null when the sheet is closed. */
  meal: ShelfMeal | null;
  /** Whether that row is in the picks right now. */
  picked: boolean;
  /** Whose read GET /meals/:id is. */
  principal: "user" | "guest";
  /** Pick / unpick — the very toggle the card's circle calls. */
  onToggle: () => void;
  onClose: () => void;
}

export function MealPreviewSheet({
  meal,
  picked,
  principal,
  onToggle,
  onClose,
}: MealPreviewSheetProps) {
  const insets = useSafeAreaInsets();
  const mealId = meal?.id ?? "";
  const guest = principal === "guest";

  const detailQuery = useQuery<MealDetail>({
    queryKey: guest ? ["guest", "meal", mealId] : ["meals", "detail", mealId, null],
    queryFn: () =>
      guest ? getMeal(mealId, undefined, { principal: "guest" }) : getMeal(mealId),
    enabled: mealId.length > 0,
  });
  const detail = detailQuery.data ?? null;

  // A guest's look is a funnel row, the recipe screen's own event with where it
  // was opened from. Once per open: a refetch of the same meal is not a second
  // look. Members post nothing.
  const firedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!mealId) {
      firedFor.current = null;
      return;
    }
    if (!guest || !detail || firedFor.current === mealId) return;
    firedFor.current = mealId;
    void trackGuestEvent("recipe_opened", { meta: { mealId, from: "pick" } });
  }, [guest, detail, mealId]);

  const togglePick = () => {
    onToggle();
    onClose();
  };

  return (
    <Modal
      visible={meal !== null}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      {meal ? (
        <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
          <View style={s.handle} />
          <View style={s.header}>
            <Text style={s.title}>{meal.title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel={PREVIEW_CLOSE}>
              <Feather name="x" size={22} color={Colors.neutral[700]} />
            </Pressable>
          </View>
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.body}
            showsVerticalScrollIndicator={false}
          >
            <TreatedImage
              source={meal.imageUrl ? { uri: meal.imageUrl } : null}
              aspectRatio={ImageTreatment.aspect.hero}
              radius={Radius.md}
            />
            <Text style={s.meta} testID="meal-preview-meta">
              {[
                timeLine(meal),
                meal.difficulty,
                detail ? `${detail.effectiveServings} servings` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {meal.description ? <Text style={s.headnote}>{meal.description}</Text> : null}

            {detailQuery.isLoading ? (
              <LoadingShim variant="inline" label={PREVIEW_LOADING} />
            ) : null}
            {detailQuery.isError ? (
              <View style={s.statusCard}>
                <Text style={s.statusTitle}>{PREVIEW_ERROR_TITLE}</Text>
                {detailQuery.error?.message ? (
                  <Text style={s.statusBody}>{detailQuery.error.message}</Text>
                ) : null}
                <Button
                  label="Try again"
                  variant="ghost"
                  onPress={() => void detailQuery.refetch()}
                  testID="meal-preview-retry"
                />
              </View>
            ) : null}
            {detail ? <MealRecipeSections meal={detail} /> : null}
          </ScrollView>
          <View style={s.footer}>
            <Button
              label={previewToggleLabel(picked)}
              variant="primary"
              onPress={togglePick}
              testID="meal-preview-toggle"
            />
            <Button
              label={PREVIEW_CLOSE}
              variant="ghost"
              onPress={onClose}
              testID="meal-preview-close"
            />
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "92%",
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[300],
    marginBottom: Spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
  },
  title: {
    flex: 1,
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // flexShrink so a long recipe scrolls inside the capped sheet and the footer
  // stays on screen.
  scroll: { flexShrink: 1 },
  body: {
    paddingTop: Spacing[3],
    paddingBottom: Spacing[4],
    gap: Spacing[3],
  },
  meta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
  },
  headnote: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  statusCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[4],
    gap: Spacing[2],
  },
  statusTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  statusBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    paddingTop: Spacing[3],
    gap: Spacing[2],
  },
});
