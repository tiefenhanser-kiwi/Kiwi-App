// BOOK-1C1 (D-WS9-312) — a season's collection view, opened from the
// Cookbook's seasonal band: a gold header ("Thanksgiving" / "Seasonal
// collection · until Nov 30"), the course chips (Feasts · Turkey · Stuffing ·
// Potatoes · Sides · Desserts · Leftovers — each shown only when it has a
// meal), the cards, and a bottom bar pointing at the season's Featured plans.
//
// Generic: everything season-specific (tag, label, window, courses, the bar's
// sentence) comes from GET /cookbook/seasons, which reads the server's config
// (lib/cookbook/seasons.ts). Christmas is a config entry, not a screen.
//
// A season outside its window is not in the response, so a stale link (a
// back-stack entry from November 30 opened on December 1) shows a plain
// "this collection has ended" line rather than an empty list pretending.

import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Chip } from "@/components/Chip";
import { CookbookResults } from "@/components/CookbookResults";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { webFullBleed } from "@/lib/webLayout";
import { useCookbookMeals, useCookbookSeasons } from "@/hooks/useCookbook";
import { collectionSubline, visibleCourses } from "@/lib/cookbook/seasons";
import { goBack } from "@/lib/navigation";

const BOTTOM_BAR_SPACE = 96;

export default function CookbookSeasonScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // WEB-4c (BUG-471) — on the web the bar's background spans the window.
  const { width: windowWidth } = useWindowDimensions();
  const { tag } = useLocalSearchParams<{ tag?: string }>();
  const seasons = useCookbookSeasons();
  const season = seasons.data?.seasons.find((s) => s.tag === tag) ?? null;
  const [course, setCourse] = useState<string | null>(null);

  // The list reads the course tag when one is picked, else the season's own.
  const results = useCookbookMeals({ tag: course ?? season?.tag ?? tag ?? null });
  const courses = season ? visibleCourses(season.courses) : [];

  const goFeatured = () =>
    router.navigate({ pathname: "/(tabs)/plans", params: { filter: "featured" } });

  const header = (
    <View style={s.chipBlock}>
      {courses.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
          <Chip label="All" selected={course === null} onPress={() => setCourse(null)} />
          {courses.map((c) => (
            <Chip
              key={c.tag}
              label={c.label}
              selected={course === c.tag}
              onPress={() => setCourse((cur) => (cur === c.tag ? null : c.tag))}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  return (
    <View style={s.screen}>
      <View style={[s.goldHeader, { paddingTop: insets.top + Spacing[2] }]}>
        <Pressable
          onPress={() => goBack(router, "/cookbook")}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={s.back}
        >
          <Feather name="chevron-left" size={24} color={Colors.neutral[900]} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{season?.label ?? " "}</Text>
          {season ? <Text style={s.subline}>{collectionSubline(season)}</Text> : null}
        </View>
      </View>

      {seasons.isLoading ? null : season === null ? (
        <View style={s.ended}>
          <Text style={s.endedText}>This seasonal collection has ended.</Text>
          <Pressable onPress={() => router.replace("/cookbook")} accessibilityRole="button">
            <Text style={s.endedLink}>Browse the Cookbook</Text>
          </Pressable>
        </View>
      ) : (
        <CookbookResults
          results={results}
          header={header}
          searchText=""
          bottomInset={season.featuredNote ? BOTTOM_BAR_SPACE : 0}
        />
      )}

      {season?.featuredNote ? (
        <View style={[webFullBleed(s.bottomBar, windowWidth), { paddingBottom: insets.bottom + Spacing[3] }]}>
          <Text style={s.bottomText}>{season.featuredNote}</Text>
          <Pressable
            onPress={goFeatured}
            accessibilityRole="button"
            style={({ pressed }) => [s.bottomBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={s.bottomBtnText}>See Featured plans</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  goldHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingHorizontal: Spacing[3],
    paddingBottom: Spacing[4],
    backgroundColor: Colors.gold.background,
    borderBottomWidth: 1.5,
    borderStyle: "dashed",
    borderBottomColor: Colors.gold.text,
  },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  title: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
    fontWeight: Typography.fontWeight.bold,
  },
  subline: {
    marginTop: 2,
    fontSize: Typography.fontSize.sm,
    // Not Colors.gold.text: 3.76:1 on this fill (tokens.ts, Palette.badge.trial).
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
  },
  chipBlock: { paddingTop: Spacing[3], paddingBottom: Spacing[3] },
  chipRow: { gap: Spacing[2], paddingRight: Spacing[4] },
  ended: { padding: Spacing[6], alignItems: "center", gap: Spacing[3] },
  endedText: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  endedLink: {
    fontSize: Typography.fontSize.base,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
    textDecorationLine: "underline",
  },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: Spacing[3],
    paddingHorizontal: Spacing[4],
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderTopWidth: 1,
    borderTopColor: Palette.border.default,
  },
  bottomText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  bottomBtn: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: Spacing[5],
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[700],
  },
  bottomBtnText: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[0],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
});
