// BOOK-1C1 (D-WS9-312) — the Cookbook filter sheet.
//
// Rows: Cuisine (multi) · Total time (Any/≤30/≤45/≤60) · Hands-on time
// (Any/≤15/≤20/≤30) · Difficulty (Easy/Medium/Hard, multi) · Nutrition per
// serving (High protein 40 g+ · Under 600 kcal) · the LOCKED allergy line ·
// one disabled line, "Eating styles: coming in December" (BOOK-1C2) · Clear all + "Show N meals".
//
// The sheet edits a DRAFT of the screen's filters; nothing applies until
// "Show N meals" (whose N is a live limit-1 count of the draft), and closing
// the sheet any other way discards the draft. The allergy line is not a
// control: the allergen filter is always on, server-side, from the stored
// preferences (BOOK-1S), and the line says so.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Chip } from "@/components/Chip";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useCookbookCount } from "@/hooks/useCookbook";
import {
  ACTIVE_CAPS,
  cuisineLabel,
  DIFFICULTIES,
  EMPTY_FILTERS,
  hasAnyFilter,
  mealCountLabel,
  TOTAL_CAPS,
  toggleCuisine,
  toggleDifficulty,
  type CookbookFilters,
} from "@/lib/cookbook/query";
import { allergyLine, EATING_STYLES_SOON_LINE } from "@/lib/cookbook/sheetCopy";
import { sheetHandleShown, webSheet } from "@/lib/webLayout";

export interface CookbookFilterSheetProps {
  visible: boolean;
  /** The screen's applied filters; the sheet starts from these. */
  filters: CookbookFilters;
  /** The search text and tag the count runs under (the filters are the draft). */
  q: string;
  tag?: string | null;
  /** Every cuisine token with a count, from the result's facet. */
  cuisines: ReadonlyArray<{ token: string; count: number }>;
  /** The user's stored allergies (display strings), or null while loading. */
  allergies: readonly string[] | null;
  onApply: (filters: CookbookFilters) => void;
  onClose: () => void;
  onOpenProfile: () => void;
}

const DIFFICULTY_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" } as const;

export function CookbookFilterSheet({
  visible,
  filters,
  q,
  tag,
  cuisines,
  allergies,
  onApply,
  onClose,
  onOpenProfile,
}: CookbookFilterSheetProps) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<CookbookFilters>(filters);
  // Each opening starts from what is applied now.
  useEffect(() => {
    if (visible) setDraft(filters);
  }, [visible, filters]);

  const count = useCookbookCount({ q, filters: draft, tag }, visible);
  const n = count.data;

  // Every cuisine the facet knows, plus a selected one the facet no longer
  // counts (so a selection can always be undone from here).
  const cuisineTokens = [
    ...cuisines.filter((c) => c.count > 0).map((c) => c.token),
    ...draft.cuisines.filter((t) => !cuisines.some((c) => c.token === t && c.count > 0)),
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close filters" />
      <View style={webSheet([s.sheet, { paddingBottom: insets.bottom + Spacing[3] }])}>
        {sheetHandleShown() && <View style={s.handle} />}
        <View style={s.header}>
          <Text style={s.title}>Filters</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          <Text style={s.section}>Cuisine</Text>
          <View style={s.chips}>
            {cuisineTokens.map((t) => (
              <Chip
                key={t}
                label={cuisineLabel(t)}
                selected={draft.cuisines.includes(t)}
                onPress={() => setDraft((d) => toggleCuisine(d, t))}
              />
            ))}
          </View>

          <Text style={s.section}>Total time</Text>
          <View style={s.chips}>
            <Chip label="Any" selected={draft.maxMinutes === null} onPress={() => setDraft((d) => ({ ...d, maxMinutes: null }))} />
            {TOTAL_CAPS.map((cap) => (
              <Chip
                key={cap}
                label={`≤ ${cap} min`}
                selected={draft.maxMinutes === cap}
                onPress={() => setDraft((d) => ({ ...d, maxMinutes: cap }))}
              />
            ))}
          </View>

          <Text style={s.section}>Hands-on time</Text>
          <View style={s.chips}>
            <Chip
              label="Any"
              selected={draft.maxActiveMinutes === null}
              onPress={() => setDraft((d) => ({ ...d, maxActiveMinutes: null }))}
            />
            {ACTIVE_CAPS.map((cap) => (
              <Chip
                key={cap}
                label={`≤ ${cap} min`}
                selected={draft.maxActiveMinutes === cap}
                onPress={() => setDraft((d) => ({ ...d, maxActiveMinutes: cap }))}
              />
            ))}
          </View>

          <Text style={s.section}>Difficulty</Text>
          <View style={s.chips}>
            {DIFFICULTIES.map((d) => (
              <Chip
                key={d}
                label={DIFFICULTY_LABEL[d]}
                selected={draft.difficulty.includes(d)}
                onPress={() => setDraft((f) => toggleDifficulty(f, d))}
              />
            ))}
          </View>

          <Text style={s.section}>Nutrition per serving</Text>
          <View style={s.chips}>
            <Chip
              label="High protein, 40 g+"
              selected={draft.highProtein}
              onPress={() => setDraft((d) => ({ ...d, highProtein: !d.highProtein }))}
            />
            <Chip
              label="Under 600 kcal"
              selected={draft.under600}
              onPress={() => setDraft((d) => ({ ...d, under600: !d.under600 }))}
            />
          </View>

          {/* The locked line: not a control. "Profile" opens the preferences. */}
          <Pressable
            onPress={onOpenProfile}
            accessibilityRole="link"
            style={({ pressed }) => [s.locked, pressed && { opacity: 0.8 }]}
          >
            <Feather name="lock" size={14} color={Colors.neutral[700]} />
            <Text style={s.lockedText}>{allergyLine(allergies)}</Text>
          </Pressable>

          {/* BOOK-1C2 — one disabled line, no named styles. Not a control:
              disabled for assistive tech (native state + aria-disabled on web). */}
          <View
            style={s.soonLine}
            accessible
            accessibilityState={{ disabled: true }}
            aria-disabled
            testID="cookbook-eating-styles"
          >
            <Text style={s.soonLineText}>{EATING_STYLES_SOON_LINE}</Text>
          </View>
        </ScrollView>

        <View style={s.footer}>
          <Pressable
            onPress={() => setDraft(EMPTY_FILTERS)}
            disabled={!hasAnyFilter(draft)}
            accessibilityRole="button"
            style={({ pressed }) => [s.clear, pressed && { opacity: 0.7 }]}
          >
            <Text style={[s.clearText, !hasAnyFilter(draft) && { color: Colors.neutral[600] }]}>Clear all</Text>
          </Pressable>
          <Pressable
            onPress={() => onApply(draft)}
            accessibilityRole="button"
            style={({ pressed }) => [s.show, pressed && { opacity: 0.85 }]}
          >
            {/* BOOK-1C2 — the previous draft's N while this draft's count
                loads: dimmed, with a spinner, never read as the answer. */}
            <View style={s.showInner} aria-busy={count.updating}>
              <Text style={[s.showText, count.updating && s.showTextUpdating]}>
                {n === undefined ? "Show meals" : `Show ${mealCountLabel(n)}`}
              </Text>
              {count.updating ? (
                <ActivityIndicator
                  size="small"
                  color={Palette.button.primary.text}
                  accessibilityLabel="Updating"
                  testID="cookbook-show-updating"
                />
              ) : null}
            </View>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Palette.background.overlay },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "90%",
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginTop: Spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
    fontWeight: Typography.fontWeight.bold,
  },
  scroll: { padding: Spacing[4], paddingBottom: Spacing[6] },
  section: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
    marginTop: Spacing[4],
    marginBottom: Spacing[2],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing[2] },
  locked: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
    marginTop: Spacing[5],
    padding: Spacing[3],
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[200],
  },
  lockedText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  soonLine: {
    marginTop: Spacing[5],
    paddingVertical: Spacing[2],
  },
  soonLineText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontStyle: "italic",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
  },
  clear: { paddingVertical: 12, paddingHorizontal: Spacing[2] },
  clearText: {
    fontSize: Typography.fontSize.base,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  show: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Palette.button.primary.background,
  },
  showInner: { flexDirection: "row", alignItems: "center", gap: Spacing[2] },
  showText: {
    fontSize: Typography.fontSize.base,
    color: Palette.button.primary.text,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  showTextUpdating: { opacity: 0.7 },
});
