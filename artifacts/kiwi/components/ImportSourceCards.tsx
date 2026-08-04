import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  importEntryParams,
  type ImportEntryContext,
} from "@/lib/builder/importEntryParams";

// WS9 3f-3 (D-WS9-005 + the Thread-A dedup) — ONE shared import-entry chooser,
// replacing the drifted copies that lived inline in AddMealsSheet (append) and
// SwapMealSheet's ImportQuartet (replace). The chooser UI is shared; the
// COMPLETION is parameterized by `context` via importEntryParams (the send side
// of the resolvePostSaveNav contract). A shared completion handler would
// recreate D-WS9-005 in every context at once — so the params, not a handler,
// carry the difference.
//
// Deliberately NOT folded in: the meal-builder mode picker (surface #3). Its
// cards are selectable ModeCards that also drive LOCAL mode switches (manual /
// combine) and a "Use dishes you've saved" option — semantics these nav-only
// sheet cards don't have. Unifying it would either bloat this component with
// context-specific props or lose that behavior; it stays on its own ModeCard.
//
// Header copy: unified to "Bring in something new" across both sheets (was
// "Add something new" in AddMealsSheet). One label, per the 3f-3 ruling.

type ImportSourcePath =
  | "/import-url"
  | "/import-image"
  | "/import-text"
  | "/meal-builder"
  | "/ask-kiwi";

interface ImportSourceCardsProps {
  /** Which completion context this chooser threads (append / replace / library). */
  context: ImportEntryContext;
  /** Render the (cosmetic, premium-pilled) "Ask Kiwi for a meal" card on top.
   *  AddMealsSheet passes true; SwapMealSheet passes false ON PURPOSE — the real
   *  shared Ask-Kiwi creator is 3f-4's work, and the dead pill was dropped. */
  includeAskKiwi?: boolean;
  /** Close the host sheet before navigating (deferred past the slide-out). */
  onClose: () => void;
}

export function ImportSourceCards({
  context,
  includeAskKiwi = false,
  onClose,
}: ImportSourceCardsProps) {
  const router = useRouter();

  // Close the sheet, then navigate after the slide-out so the destination
  // doesn't mount behind a still-collapsing modal (carried verbatim from both
  // sheets' navigateAfterClose). The context params ride along so the builder's
  // CREATE branch resolves append / replace / detail correctly.
  const navigateAfterClose = (path: ImportSourcePath) => {
    const params = importEntryParams(context);
    onClose();
    setTimeout(
      () => router.push({ pathname: path, params }),
      150,
    );
  };

  return (
    <>
      <Text style={[s.sectionTitle, s.sectionGap]}>Bring in something new</Text>
      <View style={s.list}>
        {includeAskKiwi && (
          <PremiumSourceCard
            icon="zap"
            title="Ask Kiwi for a meal"
            subtitle="Describe a meal and Kiwi drafts it to fit this plan"
            onPress={() => navigateAfterClose("/ask-kiwi")}
          />
        )}
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
          icon="clipboard"
          title="Import from text"
          subtitle="Paste a recipe from anywhere"
          onPress={() => navigateAfterClose("/import-text")}
        />
        <NewSourceCard
          icon="edit-3"
          title="Create manually"
          subtitle="Build a new meal from scratch"
          onPress={() => navigateAfterClose("/meal-builder")}
        />
      </View>
    </>
  );
}

// The single shared source card — was duplicated byte-for-byte as NewSourceCard
// in AddMealsSheet.tsx and SwapMealSheet.tsx.
export function NewSourceCard({
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
        <Feather name={icon} size={18} color={Colors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.sourceTitle}>{title}</Text>
        <Text style={s.sourceSubtitle}>{subtitle}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
    </Pressable>
  );
}

// Cosmetic premium-pilled card (subscriptionService.can() is unconditional
// allow today; the pill is carried across unchanged from AddMealsSheet).
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
        <Feather name={icon} size={18} color={Colors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.premiumTitleRow}>
          <Text style={s.sourceTitle}>{title}</Text>
          <View style={s.premiumPill}>
            <Feather name="lock" size={10} color={Colors.terracotta[700]} />
            <Text style={s.premiumPillText}>Premium</Text>
          </View>
        </View>
        <Text style={s.sourceSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sectionGap: {
    marginTop: Spacing[4],
  },
  list: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  sourceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  sourceTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sourceSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  premiumCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  premiumIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Palette.background.card,
    alignItems: "center",
    justifyContent: "center",
  },
  premiumTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
